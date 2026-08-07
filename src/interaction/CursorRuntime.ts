import * as THREE from 'three';

export class CursorRuntime {
  private readonly target = new THREE.Vector2(window.innerWidth * 0.5, window.innerHeight * 0.5);
  private readonly current = this.target.clone();
  private readonly ndcValue = new THREE.Vector2();

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.updateElement();
  }

  get ndc(): THREE.Vector2 {
    return this.ndcValue;
  }

  update(deltaSeconds: number): void {
    this.current.lerp(this.target, 1 - Math.exp(-52 * deltaSeconds));
    this.ndcValue.set(
      this.current.x / Math.max(window.innerWidth, 1) * 2 - 1,
      1 - this.current.y / Math.max(window.innerHeight, 1) * 2,
    );
    this.updateElement();
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  private updateElement(): void {
    this.element.style.transform = `translate3d(${this.current.x}px, ${this.current.y}px, 0) translate(-50%, -50%)`;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.target.set(event.clientX, event.clientY);
    this.element.classList.add('is-visible');
  };
  private readonly onPointerDown = (): void => { this.element.classList.add('is-active'); };
  private readonly onPointerUp = (): void => { this.element.classList.remove('is-active'); };
}
