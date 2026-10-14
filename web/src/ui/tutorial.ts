// First-run walkthrough for Chapter 1: a short sequence of coach marks that point at the
// source, the target, the piece palette, and the board. It advances on Next, or on its own
// when the player does what a step asks (arms a piece, places it).

import { h, setStyle } from './dom';

export interface TutorialStep {
  title: string;
  body: string;
  /** What to highlight: a screen rectangle, recomputed on each layout. */
  target: () => DOMRect | null;
  /** Advances by itself once this returns true (polled each frame). */
  done?: () => boolean;
}

export class Tutorial {
  private layer = h('div', { class: 'coach-layer' });
  private spot = h('div', { class: 'coach-spot', 'aria-hidden': 'true' });
  private card = h('div', { class: 'coach-card', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Tutorial' });
  private index = 0;
  private raf = 0;

  constructor(
    private host: HTMLElement,
    private steps: TutorialStep[],
    private finished: () => void,
  ) {
    this.layer.append(this.spot, this.card);
    host.append(this.layer);
    this.render();
    this.raf = requestAnimationFrame(this.tick);
  }

  private render(): void {
    const step = this.steps[this.index];
    if (!step) return;
    const last = this.index === this.steps.length - 1;
    this.card.replaceChildren(
      h('p', { class: 'eyebrow' }, `${this.index + 1} / ${this.steps.length}`),
      h('h2', {}, step.title),
      h('p', {}, step.body),
      h(
        'div',
        { class: 'coach-actions' },
        last ? null : h('button', { class: 'btn small', type: 'button', onclick: () => this.close() }, 'Skip'),
        h(
          'button',
          { class: 'btn small primary', type: 'button', onclick: () => this.next() },
          last ? 'Start playing' : 'Next',
        ),
      ),
    );
    (this.card.querySelector('.btn.primary') as HTMLElement | null)?.focus({ preventScroll: true });
    this.place();
  }

  /** Positions the spotlight on the step's target and the card beside it. */
  private place(): void {
    const step = this.steps[this.index];
    const host = this.host.getBoundingClientRect();
    const r = step?.target() ?? null;
    this.spot.hidden = !r;
    let cardTop = host.height / 2;
    if (r) {
      const pad = 8;
      setStyle(this.spot, 'left', `${r.left - host.left - pad}px`);
      setStyle(this.spot, 'top', `${r.top - host.top - pad}px`);
      setStyle(this.spot, 'width', `${r.width + 2 * pad}px`);
      setStyle(this.spot, 'height', `${r.height + 2 * pad}px`);
      // Card below the target when there is room, else above.
      const below = r.bottom - host.top + 18;
      cardTop = below + 200 < host.height ? below : Math.max(12, r.top - host.top - 18 - this.card.offsetHeight);
    }
    const w = Math.min(340, host.width - 24);
    const cx = r ? r.left - host.left + r.width / 2 : host.width / 2;
    setStyle(this.card, 'width', `${w}px`);
    setStyle(this.card, 'left', `${Math.max(12, Math.min(host.width - w - 12, cx - w / 2))}px`);
    setStyle(this.card, 'top', `${Math.max(12, Math.min(host.height - this.card.offsetHeight - 12, cardTop))}px`);
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.steps[this.index]?.done?.()) this.next();
    else this.place();
  };

  next(): void {
    this.index++;
    if (this.index >= this.steps.length) this.close();
    else this.render();
  }

  close(): void {
    cancelAnimationFrame(this.raf);
    this.layer.remove();
    this.finished();
  }
}
