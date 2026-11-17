import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SlaSimulatorComponent } from './sla-simulator.component';
import { SlaSimulatorService } from '../../domain/sla-simulator/sla-simulator.service';

describe('SlaSimulatorComponent', () => {
  let component: SlaSimulatorComponent;
  let fixture: ComponentFixture<SlaSimulatorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SlaSimulatorComponent],
      providers: [SlaSimulatorService]
    }).compileComponents();

    fixture = TestBed.createComponent(SlaSimulatorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create and run default simulation on init', () => {
    expect(component).toBeTruthy();
    expect(component.result).toBeDefined();
    expect(component.result?.firstResponse).toBeDefined();
    expect(component.result?.resolution).toBeDefined();
  });

  it('should update simulation results when offset is changed', () => {
    component.setOffset(60);
    expect(component.offsetMinutes).toBe(60);
    expect(component.result).toBeDefined();
  });

  it('should emit close event on close button click', () => {
    let closed = false;
    component.close.subscribe(() => (closed = true));

    const btn = fixture.nativeElement.querySelector('.btn-close') as HTMLButtonElement;
    btn.click();
    expect(closed).toBeTrue();
  });
});
