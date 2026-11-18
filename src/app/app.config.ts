import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { TICKET_GATEWAY } from './application/ticket-gateway.interface';
import { MockGateway } from './data/mock-gateway.service';
import { EventPipeline } from './domain/event-pipeline/event-pipeline';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideClientHydration(withEventReplay()),
    { provide: EventPipeline, useFactory: () => new EventPipeline() },
    { provide: TICKET_GATEWAY, useClass: MockGateway }
  ]
};
