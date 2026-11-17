import { BehaviorSubject, Observable, Subject } from 'rxjs';
import {
  Agent,
  DeskEvent,
  StreamReset,
  Ticket
} from '../models';
import {
  applyEvent,
  createInitialDeskState,
  ReducerDeskState
} from '../event-reducer';

/**
 * Represents an assembled snapshot across GET /tickets and GET /agents.
 *
 * NOTE: Resynchronization across separate REST endpoints represents best-effort consistency,
 * not atomic server-side snapshot consistency. Full pagination traversal and agent retrieval
 * must be assembled in Step 2 before being handed to this pipeline.
 */
export interface DeskSnapshot {
  readonly lastSeq: number;
  readonly tickets: Readonly<Record<string, Ticket>>;
  readonly agents: Readonly<Record<string, Agent>>; // Mandatory for complete resynchronization
}

/**
 * Synchronization lifecycle status of the event pipeline.
 */
export type PipelineSyncStatus = 'synced' | 'resyncing' | 'desynchronized' | 'error';

/**
 * Configuration options for EventPipeline.
 */
export interface EventPipelineConfig {
  /** Maximum number of out-of-order events to hold before triggering a gap overflow. Default: 50. */
  readonly maxBufferWindow?: number;
  /** Injectable clock returning the current evaluation Date. Default: system clock. */
  readonly clock?: () => Date;
}

function isReducerDeskState(obj: unknown): obj is ReducerDeskState {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'parkedEvents' in obj &&
    'processedEventIds' in obj &&
    'tickets' in obj &&
    'lastSeq' in obj
  );
}

/**
 * EventPipeline maintains contiguous sequence ordering, detects sequence gaps,
 * buffers out-of-order events, guards against stale connection epochs, manages
 * StreamReset boundaries without UI flicker, and validates complete snapshots.
 */
export class EventPipeline {
  private _state: ReducerDeskState;
  private _currentEpoch = 1;
  private _pendingResetSeq: number | null = null;
  private _pendingResetEventId: string | null = null;
  private _syncStatus: PipelineSyncStatus = 'synced';
  private readonly _sequenceBuffer = new Map<number, DeskEvent>();
  private readonly _maxBufferWindow: number;
  private readonly _clock: () => Date;

  private readonly _state$: BehaviorSubject<ReducerDeskState>;
  private readonly _syncStatus$ = new BehaviorSubject<PipelineSyncStatus>('synced');
  private readonly _error$ = new Subject<Error>();
  private readonly _gapOverflow$ = new Subject<{ missingSeq: number; bufferedCount: number }>();

  public readonly state$: Observable<ReducerDeskState>;
  public readonly syncStatus$: Observable<PipelineSyncStatus> = this._syncStatus$.asObservable();
  public readonly error$: Observable<Error> = this._error$.asObservable();
  public readonly gapOverflow$: Observable<{ missingSeq: number; bufferedCount: number }> =
    this._gapOverflow$.asObservable();

  constructor(
    initialStateOrAgents?: ReducerDeskState | Readonly<Record<string, Agent>>,
    config?: EventPipelineConfig
  ) {
    this._maxBufferWindow = config?.maxBufferWindow ?? 50;
    this._clock = config?.clock ?? (() => new Date());

    if (isReducerDeskState(initialStateOrAgents)) {
      this._state = initialStateOrAgents;
    } else {
      this._state = createInitialDeskState(
        initialStateOrAgents as Readonly<Record<string, Agent>> | undefined,
        this._clock()
      );
    }

    this._state$ = new BehaviorSubject<ReducerDeskState>(this._state);
    this.state$ = this._state$.asObservable();
  }

  /**
   * The current synchronous domain state.
   */
  public get state(): ReducerDeskState {
    return this._state;
  }

  /**
   * The current active connection epoch.
   */
  public get currentEpoch(): number {
    return this._currentEpoch;
  }

  /**
   * Alias for currentEpoch, returning the active connection epoch.
   */
  public getEpoch(): number {
    return this._currentEpoch;
  }

  /**
   * The current synchronization status.
   */
  public get syncStatus(): PipelineSyncStatus {
    return this._syncStatus;
  }

  /**
   * The pending reset boundary sequence, or null if fully synchronized.
   */
  public get pendingResetSeq(): number | null {
    return this._pendingResetSeq;
  }

  /**
   * The number of out-of-order events currently buffered.
   */
  public get bufferedCount(): number {
    return this._sequenceBuffer.size;
  }

  /**
   * Returns a copy of the currently buffered events sorted by sequence ascending.
   */
  public getBufferedEvents(): readonly DeskEvent[] {
    return Array.from(this._sequenceBuffer.values()).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Calculates the missing sequence numbers between the stream baseline and the highest buffered event.
   */
  public getMissingSequences(): readonly number[] {
    if (this._sequenceBuffer.size === 0) {
      return [];
    }

    const baseline = this._pendingResetSeq ?? this._state.lastSeq;
    const sortedSeqs = Array.from(this._sequenceBuffer.keys()).sort((a, b) => a - b);
    const maxSeq = sortedSeqs[sortedSeqs.length - 1];
    const missing: number[] = [];

    for (let s = baseline + 1; s < maxSeq; s++) {
      if (!this._sequenceBuffer.has(s)) {
        missing.push(s);
      }
    }

    return missing;
  }

  /**
   * Receives and processes an incoming DeskEvent with its connection epoch.
   */
  public handleEvent(event: DeskEvent, epoch: number): void {
    // 1. Connection Epoch Guard: reject callbacks from previous connection epochs
    if (epoch !== this._currentEpoch) {
      return;
    }

    // 2. Validate event format: seq must be a non-negative safe integer
    if (
      !event ||
      typeof event !== 'object' ||
      typeof event.seq !== 'number' ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0 ||
      typeof event.eventId !== 'string' ||
      !event.eventId ||
      !event.type
    ) {
      throw new Error(`Invalid DeskEvent received: ${JSON.stringify(event)}`);
    }

    // 3. Handle StreamReset separately
    if (event.type === 'StreamReset') {
      this.handleStreamReset(event);
      return;
    }

    // If desynchronized, stream is corrupted and cannot proceed
    if (this._syncStatus === 'desynchronized') {
      return;
    }

    // If in error state:
    // When pendingResetSeq is active (awaiting snapshot retry), live events on the valid
    // new connection epoch must continue to be buffered so they are preserved when snapshot retry succeeds.
    // If pendingResetSeq is null, normal ingestion is halted in error state.
    if (this._syncStatus === 'error' && this._pendingResetSeq === null) {
      return;
    }

    // 4. Obsolete pre-reset event filtering (during pending reset)
    if (this._pendingResetSeq !== null) {
      if (event.seq <= this._pendingResetSeq) {
        // Discard pre-reset event
        return;
      }
    } else {
      // 5. Stale / pre-applied sequence filtering (in normal synced mode)
      if (event.seq <= this._state.lastSeq) {
        return;
      }
    }

    // 6. Duplicate eventId with Different Sequence (Option 1: Protocol Violation)
    if (this._state.processedEventIds[event.eventId]) {
      this.setSyncStatus('desynchronized');
      const err = new Error(
        `Protocol violation: eventId '${event.eventId}' was already processed, but arrived with new seq ${event.seq}. Stream requires resynchronization.`
      );
      this._error$.next(err);
      return;
    }

    // 7. Resyncing Mode: All events with seq > pendingResetSeq must be buffered
    if (this._pendingResetSeq !== null) {
      this.bufferEvent(event, this._pendingResetSeq + 1);
      return;
    }

    // 8. Normal Synced Mode:
    const expectedSeq = this._state.lastSeq + 1;

    if (event.seq === expectedSeq) {
      // Contiguous next event in sequence: apply directly
      this.applyEventToReducer(event);
      // Attempt to drain any contiguous events waiting in buffer
      this.drainSequenceBuffer();
    } else {
      // Sequence gap detected: buffer event
      this.bufferEvent(event, expectedSeq);
    }
  }

  /**
   * Notifies the pipeline that snapshot fetching failed.
   * Leaves the existing visible board intact and transitions syncStatus to 'error'.
   */
  public notifySnapshotFailure(error: Error): void {
    this.setSyncStatus('error');
    this._error$.next(error);
  }

  /**
   * Synchronously and atomically applies a complete DeskSnapshot.
   * Validates mandatory agents, referential integrity, and recomputes agentLoad.
   */
  public syncSnapshot(snapshot: DeskSnapshot, now?: Date): void {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('Invalid snapshot: DeskSnapshot is required.');
    }

    if (
      typeof snapshot.lastSeq !== 'number' ||
      !Number.isSafeInteger(snapshot.lastSeq) ||
      snapshot.lastSeq < 0
    ) {
      this.setSyncStatus('error');
      const err = new Error(
        `Invalid snapshot: lastSeq '${snapshot?.lastSeq}' must be a non-negative safe integer.`
      );
      this._error$.next(err);
      return;
    }

    // Validate that snapshot is not older than pendingResetSeq
    if (this._pendingResetSeq !== null && snapshot.lastSeq < this._pendingResetSeq) {
      this.setSyncStatus('error');
      const err = new Error(
        `Stale snapshot rejected: snapshot.lastSeq (${snapshot.lastSeq}) is less than pendingResetSeq (${this._pendingResetSeq}).`
      );
      this._error$.next(err);
      return;
    }

    // Rule 1: Missing agents data strictly rejected
    if (
      snapshot.agents === undefined ||
      snapshot.agents === null ||
      typeof snapshot.agents !== 'object'
    ) {
      this.setSyncStatus('error');
      const err = new Error('Incomplete snapshot rejected: agents collection is missing.');
      this._error$.next(err);
      return;
    }

    // Rule 2: Missing tickets data strictly rejected
    if (
      snapshot.tickets === undefined ||
      snapshot.tickets === null ||
      typeof snapshot.tickets !== 'object'
    ) {
      this.setSyncStatus('error');
      const err = new Error('Incomplete snapshot rejected: tickets collection is missing.');
      this._error$.next(err);
      return;
    }

    // Rule 3: Referential Integrity Validation: all assigned tickets must reference existing agents
    for (const [ticketId, ticket] of Object.entries(snapshot.tickets)) {
      if (ticket.assigneeId && ticket.assigneeId.length > 0) {
        if (!snapshot.agents[ticket.assigneeId]) {
          this.setSyncStatus('error');
          const err = new Error(
            `Referential violation in snapshot: Ticket '${ticketId}' is assigned to unknown agent '${ticket.assigneeId}'. Agent must exist in snapshot.agents.`
          );
          this._error$.next(err);
          return;
        }
      }
    }

    // Rule 4: Recompute agentLoad from scratch
    const agentLoad: Record<string, number> = {};
    for (const agentId of Object.keys(snapshot.agents)) {
      agentLoad[agentId] = 0;
    }
    for (const ticket of Object.values(snapshot.tickets)) {
      if (ticket.assigneeId && ticket.status !== 'resolved') {
        agentLoad[ticket.assigneeId] = (agentLoad[ticket.assigneeId] ?? 0) + 1;
      }
    }

    // Rule 5: Evict buffered events covered by the snapshot (seq <= snapshot.lastSeq)
    for (const seq of Array.from(this._sequenceBuffer.keys())) {
      if (seq <= snapshot.lastSeq) {
        this._sequenceBuffer.delete(seq);
      }
    }

    // Rule 6: Atomic State Publication (Zero UI flicker)
    const evaluationDate = now ?? this._clock();
    const processedEventIds: Record<string, true> = {
      ...this._state.processedEventIds
    };
    if (this._pendingResetEventId) {
      processedEventIds[this._pendingResetEventId] = true;
    }

    this._state = {
      tickets: { ...snapshot.tickets },
      agents: { ...snapshot.agents },
      agentLoad,
      lastSeq: snapshot.lastSeq,
      lastUpdatedAt: evaluationDate,
      parkedEvents: {},
      processedEventIds
    };

    this._pendingResetSeq = null;
    this._pendingResetEventId = null;
    this.setSyncStatus('synced');
    this._state$.next(this._state);

    // Rule 7: Drain any buffered post-snapshot events
    this.drainSequenceBuffer();
  }

  /**
   * Handles StreamReset events.
   * Rejects stale resets. On valid reset, increments connection epoch, clears old buffer,
   * sets pendingResetSeq, and preserves visible board on state$.
   */
  private handleStreamReset(event: StreamReset): void {
    const baseline = this._pendingResetSeq ?? this._state.lastSeq;

    // Reject stale resets
    if (event.seq <= baseline) {
      return;
    }

    // Reject if eventId already processed or already pending reset
    if (
      this._state.processedEventIds[event.eventId] ||
      this._pendingResetEventId === event.eventId
    ) {
      return;
    }

    // Valid StreamReset (Phase 1 of Anti-Flicker Lifecycle):
    this._pendingResetSeq = event.seq;
    this._pendingResetEventId = event.eventId;
    this._currentEpoch++;
    this._sequenceBuffer.clear();
    this.setSyncStatus('resyncing');
    // Note: this._state$ is NOT emitted; existing visible board is retained.
  }

  /**
   * Buffers an out-of-order event, enforcing duplicate and conflict rules.
   */
  private bufferEvent(event: DeskEvent, expectedSeq: number): void {
    const existing = this._sequenceBuffer.get(event.seq);

    if (existing) {
      if (existing.eventId === event.eventId) {
        // Case A: Identical Duplicate while buffered -> silently drop
        return;
      } else {
        // Case B: Conflicting Sequence Collision while buffered -> Protocol Violation!
        this.setSyncStatus('desynchronized');
        const err = new Error(
          `Protocol violation: Sequence conflict at seq ${event.seq}. Incoming eventId '${event.eventId}' conflicts with buffered '${existing.eventId}'.`
        );
        this._error$.next(err);
        return;
      }
    }

    // Check if eventId already exists in buffer at a DIFFERENT sequence:
    for (const buffered of this._sequenceBuffer.values()) {
      if (buffered.eventId === event.eventId) {
        this.setSyncStatus('desynchronized');
        const err = new Error(
          `Protocol violation: Duplicate eventId '${event.eventId}' detected in sequence buffer at seq ${buffered.seq} and incoming seq ${event.seq}.`
        );
        this._error$.next(err);
        return;
      }
    }

    // Check maximum sequence gap distance (how far ahead seq is from expected missing seq)
    const gapDistance = event.seq - expectedSeq;

    if (gapDistance > this._maxBufferWindow) {
      this.triggerGapOverflow(
        expectedSeq,
        `Sequence gap distance of ${gapDistance} (seq ${event.seq} relative to expected seq ${expectedSeq}) exceeds maximum window of ${this._maxBufferWindow}.`
      );
      return;
    }

    this._sequenceBuffer.set(event.seq, event);

    // Check buffer window limit (number of items in buffer)
    if (this._sequenceBuffer.size > this._maxBufferWindow) {
      this.triggerGapOverflow(
        expectedSeq,
        `Buffer size of ${this._sequenceBuffer.size} exceeded maximum window of ${this._maxBufferWindow} while waiting for missing seq ${expectedSeq}.`
      );
    }
  }

  /**
   * Drains contiguous events from the buffer into EventReducer.
   */
  private drainSequenceBuffer(): void {
    if (
      this._syncStatus === 'desynchronized' ||
      this._syncStatus === 'error' ||
      this._pendingResetSeq !== null
    ) {
      return;
    }

    while (this._sequenceBuffer.has(this._state.lastSeq + 1)) {
      const nextSeq = this._state.lastSeq + 1;
      const nextEvent = this._sequenceBuffer.get(nextSeq)!;
      this._sequenceBuffer.delete(nextSeq);
      this.applyEventToReducer(nextEvent);
    }
  }

  /**
   * Applies an event immutably to EventReducer and emits updated state.
   */
  private applyEventToReducer(event: DeskEvent): void {
    const now = this._clock();
    this._state = applyEvent(this._state, event, now);
    this._state$.next(this._state);
  }

  /**
   * Triggers a gap overflow when the buffer window is exceeded.
   */
  private triggerGapOverflow(missingSeq: number, customMessage?: string): void {
    const count = this._sequenceBuffer.size;
    this._sequenceBuffer.clear();
    this.setSyncStatus('desynchronized');
    this._gapOverflow$.next({ missingSeq, bufferedCount: count });
    this._error$.next(
      new Error(
        customMessage ??
          `Sequence gap overflow: buffer exceeded maximum window of ${this._maxBufferWindow} while waiting for missing seq ${missingSeq}.`
      )
    );
  }

  /**
   * Sets internal status and emits to syncStatus$.
   */
  private setSyncStatus(status: PipelineSyncStatus): void {
    this._syncStatus = status;
    this._syncStatus$.next(status);
  }
}
