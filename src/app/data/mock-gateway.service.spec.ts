import { TestBed } from '@angular/core/testing';
import { DEFAULT_MOCK_AGENTS, MockGateway, generateMockTickets } from './mock-gateway.service';
import { DeskEvent, TicketAssigned } from '../domain/models';

describe('MockGateway', () => {
  let gateway: MockGateway;

  beforeEach(() => {
    // Use deterministic mode with small ticket set for fast unit testing
    gateway = new MockGateway({
      totalTickets: 50,
      pageSize: 10,
      deterministic: true
    });
  });

  describe('Initialization and Mock Generation', () => {
    it('should generate 5,000 tickets with valid properties by default', () => {
      const tickets = generateMockTickets(5000);
      expect(tickets.length).toBe(5000);
      expect(tickets[0].id).toBe('ticket-1');
      expect(tickets[4999].id).toBe('ticket-5000');
      expect(['EG', 'AE', 'SA', 'EU']).toContain(tickets[0].region);
      expect(['P1', 'P2', 'P3', 'P4']).toContain(tickets[0].priority);
    });

    it('should initialize with default agents', (done) => {
      gateway.getAgents().subscribe({
        next: (agents) => {
          expect(agents.length).toBe(DEFAULT_MOCK_AGENTS.length);
          expect(agents.map(a => a.id)).toEqual(DEFAULT_MOCK_AGENTS.map(a => a.id));
          done();
        },
        error: done.fail
      });
    });
  });

  describe('Pagination (getTickets)', () => {
    it('should paginate tickets correctly', (done) => {
      gateway.getTickets(1, 10).subscribe({
        next: (res) => {
          expect(res.total).toBe(50);
          expect(res.page).toBe(1);
          expect(res.pageSize).toBe(10);
          expect(res.totalPages).toBe(5);
          expect(res.tickets.length).toBe(10);
          expect(res.tickets[0].id).toBe('ticket-1');
          expect(res.tickets[9].id).toBe('ticket-10');

          gateway.getTickets(2, 10).subscribe({
            next: (page2) => {
              expect(page2.page).toBe(2);
              expect(page2.tickets.length).toBe(10);
              expect(page2.tickets[0].id).toBe('ticket-11');
              done();
            },
            error: done.fail
          });
        },
        error: done.fail
      });
    });

    it('should simulate HTTP 500 when forced', (done) => {
      gateway.forceHttp500 = true;
      gateway.getTickets(1, 10).subscribe({
        next: () => done.fail('Should have failed with HTTP 500'),
        error: (err: Error) => {
          expect(err.message).toContain('HTTP 500: Failed to fetch tickets page 1');
          done();
        }
      });
    });
  });

  describe('Real-Time Event Stream (getEventStream)', () => {
    it('should capture epoch immutably and forward emitted events', (done) => {
      expect(gateway.activeConnectionCount).toBe(0);

      const stream$ = gateway.getEventStream(42);
      expect(gateway.activeConnectionCount).toBe(0); // Not subscribed yet

      const sub = stream$.subscribe({
        next: (payload) => {
          expect(payload.epoch).toBe(42);
          expect(payload.event.type).toBe('TicketAssigned');
          expect((payload.event as TicketAssigned).ticketId).toBe('ticket-1');
          sub.unsubscribe();
          expect(gateway.activeConnectionCount).toBe(0);
          done();
        },
        error: done.fail
      });

      expect(gateway.activeConnectionCount).toBe(1);

      gateway.emitEvent({
        type: 'TicketAssigned',
        eventId: 'evt-test-1',
        seq: 1,
        ticketId: 'ticket-1',
        agentId: 'agent-alice',
        version: 2
      });
    });

    it('should decrement activeConnectionCount upon unsubscription', () => {
      const sub1 = gateway.getEventStream(1).subscribe();
      const sub2 = gateway.getEventStream(2).subscribe();
      expect(gateway.activeConnectionCount).toBe(2);

      sub1.unsubscribe();
      expect(gateway.activeConnectionCount).toBe(1);

      sub2.unsubscribe();
      expect(gateway.activeConnectionCount).toBe(0);
    });
  });

  describe('Optimistic Assignment & Concurrency Control (assignTicket)', () => {
    it('should assign ticket and increment version when version matches', (done) => {
      gateway.assignTicket('ticket-1', 'agent-dana', 1).subscribe({
        next: (updatedTicket) => {
          expect(updatedTicket.id).toBe('ticket-1');
          expect(updatedTicket.assigneeId).toBe('agent-dana');
          expect(updatedTicket.version).toBe(2);
          done();
        },
        error: done.fail
      });
    });

    it('should throw HTTP 409 Conflict when version does not match', (done) => {
      gateway.assignTicket('ticket-1', 'agent-dana', 999).subscribe({
        next: () => done.fail('Should have thrown HTTP 409'),
        error: (err: Error) => {
          expect(err.message).toContain('HTTP 409 Conflict');
          expect(err.message).toContain('Expected version 1, received 999');
          done();
        }
      });
    });

    it('should throw HTTP 404 when ticket is not found', (done) => {
      gateway.assignTicket('ticket-non-existent', 'agent-dana', 1).subscribe({
        next: () => done.fail('Should have thrown HTTP 404'),
        error: (err: Error) => {
          expect(err.message).toContain('HTTP 404');
          done();
        }
      });
    });

    it('should broadcast TicketAssigned event on stream when assign succeeds', (done) => {
      let eventReceived: DeskEvent | undefined;
      const sub = gateway.getEventStream(1).subscribe({
        next: (msg) => {
          if (msg.event.type === 'TicketAssigned' && (msg.event as TicketAssigned).ticketId === 'ticket-2') {
            eventReceived = msg.event;
          }
        }
      });

      gateway.assignTicket('ticket-2', 'agent-alice', 1).subscribe({
        next: () => {
          expect(eventReceived).toBeDefined();
          expect(eventReceived?.type).toBe('TicketAssigned');
          expect((eventReceived as TicketAssigned).agentId).toBe('agent-alice');
          sub.unsubscribe();
          done();
        },
        error: done.fail
      });
    });
  });

  describe('Agent and Ticket Status Updates', () => {
    it('should update agent status and emit event', (done) => {
      let eventEmitted = false;
      const sub = gateway.getEventStream(1).subscribe({
        next: (msg) => {
          if (msg.event.type === 'AgentStatusChanged' && msg.event.agentId === 'agent-alice') {
            eventEmitted = true;
          }
        }
      });

      gateway.updateAgentStatus('agent-alice', 'busy').subscribe({
        next: (updatedAgent) => {
          expect(updatedAgent.status).toBe('busy');
          expect(eventEmitted).toBeTrue();
          sub.unsubscribe();
          done();
        },
        error: done.fail
      });
    });

    it('should update ticket status and append history', (done) => {
      gateway.updateTicketStatus('ticket-1', 'on_hold').subscribe({
        next: (t) => {
          expect(t.status).toBe('on_hold');
          expect(t.statusHistory[t.statusHistory.length - 1].status).toBe('on_hold');
          expect(t.version).toBe(2);
          done();
        },
        error: done.fail
      });
    });

    it('should emit StreamReset event correctly', (done) => {
      const sub = gateway.getEventStream(5).subscribe({
        next: (msg) => {
          if (msg.event.type === 'StreamReset') {
            expect(msg.event.seq).toBe(100);
            sub.unsubscribe();
            done();
          }
        }
      });

      gateway.triggerStreamReset(100, 5);
    });
  });
});
