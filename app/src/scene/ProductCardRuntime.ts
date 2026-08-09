import * as THREE from 'three';
import type { CameraRuntime } from './CameraRuntime';

interface ProductSpec {
  label: string;
  value: string;
}

interface ProductCardDefinition {
  description: string;
  id: string;
  layout?: 'detail';
  name: string;
  specs: ProductSpec[];
  type: string;
}

interface ProductCardBinding {
  anchor: THREE.Object3D;
  definition: ProductCardDefinition;
  element: HTMLElement;
  connector: SVGSVGElement;
  connectorPath: SVGPathElement;
  connectorDot: SVGCircleElement;
  target: THREE.Object3D;
}

const PRODUCT_CARDS: ProductCardDefinition[] = [
  {
    id: 'SpeakerLeft',
    name: 'KERN BW6',
    type: '2-WAY BASS-REFLEX MONITOR',
    specs: [
      { label: 'Frequency response', value: '42 Hz — 38 kHz' },
      { label: 'Sensitivity', value: '87 dB' },
      { label: 'Nominal impedance', value: '6 Ω' },
      { label: 'Amplifier power', value: '20 — 140 W' },
    ],
    description: 'A compact two-way loudspeaker designed for near-field and room stereo listening.',
  },
  {
    id: 'PlayerTop',
    name: 'KERN C100',
    type: 'COMPACT DIGITAL AMPLIFIER\nAND CD TRANSPORT',
    specs: [
      { label: 'Output power', value: '2 × 50 W  /  4 Ω' },
      { label: 'Speaker load', value: '4 — 16 Ω' },
      { label: 'Frequency response', value: '20 Hz — 90 kHz' },
    ],
    description: 'A compact stereo control centre combining disc playback and digital amplification.',
  },
  {
    id: 'SpeakerRightTop',
    layout: 'detail',
    name: '25 mm',
    type: 'ALUMINIUM-DOME TWEETER',
    specs: [
      { label: 'Crossover', value: '2.0 kHz' },
      { label: 'Upper extension', value: '38 kHz  /  −6 dB' },
    ],
    description: 'A shallow waveguide controls dispersion around the crossover region.',
  },
];

function createCard(definition: ProductCardDefinition): HTMLElement {
  const card = document.createElement('article');
  card.className = 'product-card';
  if (definition.layout) card.classList.add(`product-card--${definition.layout}`);
  card.setAttribute('aria-label', `${definition.name} product information`);

  const heading = document.createElement('header');
  heading.className = 'product-card__heading';
  const name = document.createElement('h2');
  name.className = 'product-card__name';
  name.textContent = definition.name;
  const type = document.createElement('p');
  type.className = 'product-card__type';
  type.textContent = definition.type;
  heading.append(name, type);

  const specs = document.createElement('dl');
  specs.className = 'product-card__specs';
  definition.specs.forEach((spec) => {
    const group = document.createElement('div');
    group.className = 'product-card__spec';
    const value = document.createElement('dd');
    value.textContent = spec.value;
    const label = document.createElement('dt');
    label.textContent = spec.label;
    group.append(value, label);
    specs.append(group);
  });

  const description = document.createElement('p');
  description.className = 'product-card__description';
  description.textContent = definition.description;
  card.append(heading, specs, description);
  return card;
}

export class ProductCardRuntime {
  private readonly bindings: ProductCardBinding[] = [];
  private readonly projected = new THREE.Vector3();
  private readonly targetProjected = new THREE.Vector3();
  private debugMode = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly cameraRuntime: CameraRuntime,
    markers: readonly THREE.Object3D[],
    private readonly root: HTMLElement,
  ) {
    PRODUCT_CARDS.forEach((definition) => {
      const anchor = markers.find((candidate) => candidate.name === `UI_ProductCard_${definition.id}`);
      const targetNames = [
        `UI_ProductTarget_${definition.id}`,
        `UI_ProductCardTarget_${definition.id}`,
      ];
      const target = markers.find((candidate) => targetNames.includes(candidate.name));
      if (!anchor || !target) return;
      const element = createCard(definition);
      const connector = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      connector.classList.add('product-card__connector');
      connector.setAttribute('aria-hidden', 'true');
      const connectorPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      connectorPath.classList.add('product-card__connector-path');
      const connectorDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      connectorDot.classList.add('product-card__connector-dot');
      connectorDot.setAttribute('r', '3.5');
      connector.append(connectorPath, connectorDot);
      root.append(connector, element);
      this.bindings.push({ anchor, definition, element, connector, connectorPath, connectorDot, target });
    });
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
    this.root.classList.toggle('is-debug', enabled);
  }

  update(): void {
    const activeCamera = this.cameraRuntime.currentPoseName;
    const canShow = !this.debugMode && !this.cameraRuntime.isTransitioning;
    this.bindings.forEach((binding) => {
      const visible = canShow && activeCamera === `CAM_${binding.definition.id}`;
      this.place(binding, visible);
    });
  }

  dispose(): void {
    this.bindings.forEach(({ element, connector }) => {
      element.remove();
      connector.remove();
    });
    this.bindings.length = 0;
  }

  private place(binding: ProductCardBinding, enabled: boolean): void {
    const { anchor, connector, connectorDot, connectorPath, element, target } = binding;
    if (!enabled) {
      element.classList.remove('is-visible');
      connector.classList.remove('is-visible');
      element.setAttribute('aria-hidden', 'true');
      return;
    }
    anchor.updateWorldMatrix(true, false);
    this.projected.copy(anchor.getWorldPosition(this.projected)).project(this.camera);
    const inDepth = this.projected.z > -1 && this.projected.z < 1;
    if (!inDepth) {
      element.classList.remove('is-visible');
      connector.classList.remove('is-visible');
      element.setAttribute('aria-hidden', 'true');
      return;
    }

    const anchorX = (this.projected.x * 0.5 + 0.5) * window.innerWidth;
    const anchorY = (-this.projected.y * 0.5 + 0.5) * window.innerHeight;
    const width = element.offsetWidth || 336;
    const height = element.offsetHeight || 330;
    const desiredX = anchorX - width * 0.5;
    const x = THREE.MathUtils.clamp(desiredX, 18, Math.max(18, window.innerWidth - width - 18));
    const y = THREE.MathUtils.clamp(anchorY - height * 0.5, 58, Math.max(58, window.innerHeight - height - 48));
    element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    element.setAttribute('aria-hidden', 'false');
    element.classList.add('is-visible');
    this.placeConnector(target, x, y, width, height, connector, connectorPath, connectorDot);
  }

  private placeConnector(
    target: THREE.Object3D,
    cardX: number,
    cardY: number,
    cardWidth: number,
    cardHeight: number,
    connector: SVGSVGElement,
    path: SVGPathElement,
    dot: SVGCircleElement,
  ): void {
    target.updateWorldMatrix(true, false);
    this.targetProjected.copy(target.getWorldPosition(this.targetProjected)).project(this.camera);
    const targetX = (this.targetProjected.x * 0.5 + 0.5) * window.innerWidth;
    const targetY = (-this.targetProjected.y * 0.5 + 0.5) * window.innerHeight;
    const cardCenterX = cardX + cardWidth * 0.5;
    const targetIsLeft = targetX < cardCenterX;
    const startX = targetIsLeft ? cardX : cardX + cardWidth;
    const startY = THREE.MathUtils.clamp(targetY, cardY + 28, cardY + cardHeight - 28);
    const elbowX = startX + (targetIsLeft ? -22 : 22);
    connector.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
    path.setAttribute('d', `M ${startX} ${startY} L ${elbowX} ${startY} L ${targetX} ${targetY}`);
    dot.setAttribute('cx', `${targetX}`);
    dot.setAttribute('cy', `${targetY}`);
    connector.classList.add('is-visible');
  }
}
