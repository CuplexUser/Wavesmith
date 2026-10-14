// The one-time purchase that unlocks the full game. In the Android app it goes through Google
// Play Billing (android/.../BillingPlugin.java); on the web the store isn't available and
// the paid chapters link to the Play listing instead.

import { registerPlugin } from '@capacitor/core';
import { isNative } from './native';

/** In-app product ID; create a one-time product with this ID in the Play Console. */
export const FULL_GAME_PRODUCT = 'full_game';

/** Where the web demo sends players for the full game. Update once the listing is live. */
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=se.cuplex.wavesmith';

interface BillingPlugin {
  getProduct(o: { productId: string }): Promise<{ productId: string; title: string; price: string | null }>;
  purchase(o: { productId: string }): Promise<{ owned: boolean; cancelled: boolean }>;
  restore(o: { productId: string }): Promise<{ owned: boolean }>;
}

export type PurchaseResult = 'owned' | 'cancelled' | 'failed';

export interface Store {
  /** Purchases can be made here (the Android app). */
  readonly available: boolean;
  /** Localized price, e.g. "€4.99", or null when unknown. */
  price(): Promise<string | null>;
  buy(): Promise<PurchaseResult>;
  /** Whether the full game was bought before (reinstalls, new devices). */
  restore(): Promise<boolean>;
}

class WebStore implements Store {
  readonly available = false;
  async price(): Promise<string | null> {
    return null;
  }
  async buy(): Promise<PurchaseResult> {
    return 'failed';
  }
  async restore(): Promise<boolean> {
    return false;
  }
}

class PlayStore implements Store {
  readonly available = true;
  private plugin = registerPlugin<BillingPlugin>('Billing');

  async price(): Promise<string | null> {
    try {
      return (await this.plugin.getProduct({ productId: FULL_GAME_PRODUCT })).price;
    } catch {
      return null;
    }
  }

  async buy(): Promise<PurchaseResult> {
    try {
      const r = await this.plugin.purchase({ productId: FULL_GAME_PRODUCT });
      return r.owned ? 'owned' : r.cancelled ? 'cancelled' : 'failed';
    } catch {
      return 'failed';
    }
  }

  async restore(): Promise<boolean> {
    try {
      return (await this.plugin.restore({ productId: FULL_GAME_PRODUCT })).owned;
    } catch {
      return false;
    }
  }
}

export function createStore(): Store {
  return isNative() ? new PlayStore() : new WebStore();
}
