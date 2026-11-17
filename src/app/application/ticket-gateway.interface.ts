import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { Agent, DeskEvent, Ticket } from '../domain/models';

/**
 * Paginated response structure for ticket queries.
 */
export interface PaginatedTickets {
  readonly tickets: readonly Ticket[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages?: number;
}

/**
 * Minimum TicketGateway interface required by the original TDD.
 * Defines the contract for fetching tickets, agents, streaming events, and mutations.
 * Step 2 will implement MockGateway implementing this interface.
 */
export interface TicketGateway {
  /**
   * Fetches a paginated page of tickets.
   */
  getTickets(page?: number, pageSize?: number): Observable<PaginatedTickets>;

  /**
   * Fetches all registered agents.
   */
  getAgents(): Observable<readonly Agent[]>;

  /**
   * Connects to the real-time event stream.
   *
   * STREAM LIFECYCLE & EPOCH CAPTURE CONTRACT:
   * 1. Immutable Epoch Capture:
   *    When getEventStream(epoch) is invoked, the transport adapter implementing TicketGateway
   *    must capture the provided `epoch` parameter at connection creation time and immutably attach
   *    it to every incoming event delivered through the Observable: `{ event: DeskEvent; epoch: number }`.
   *    The transport adapter MUST NOT dynamically read the pipeline's epoch at event-delivery time;
   *    each callback must carry the epoch that was valid when this specific connection was established.
   *
   * 2. Teardown / Close:
   *    The returned Observable must clean up its underlying transport (e.g., WebSocket.close(),
   *    EventSource.close(), or Subject unsubscription) when unsubscribed.
   *
   * 3. Reconnection Lifecycle after StreamReset:
   *    - Who detects resyncing: DeskFacade observes EventPipeline.syncStatus$ transition to 'resyncing'.
   *    - Who closes old connection: DeskFacade unsubscribes from the existing stream subscription,
   *      triggering transport closure.
   *    - Who establishes new connection: DeskFacade calls getEventStream(newEpoch).
   *    - How new epoch is captured: EventPipeline increments its epoch during handleStreamReset();
   *      DeskFacade reads this updated value via pipeline.getEpoch() and passes it to getEventStream().
   *    - Duplicate prevention: DeskFacade manages a single stream subscription reference; any existing
   *      subscription is unsubscribed before opening a new one, ensuring at most one active connection.
   *    - Error handling: The subscription error handler catches reconnection failures, updates facade state,
   *      and exposes the error on facade.error$.
   */
  getEventStream?(epoch?: number): Observable<{ event: DeskEvent; epoch: number }>;

  /**
   * Sends an assignment mutation to the server.
   */
  assignTicket?(ticketId: string, agentId: string, version: number): Observable<Ticket>;
}

/**
 * Injection token for injecting a TicketGateway implementation into Angular components/services.
 */
export const TICKET_GATEWAY = new InjectionToken<TicketGateway>('TICKET_GATEWAY');
