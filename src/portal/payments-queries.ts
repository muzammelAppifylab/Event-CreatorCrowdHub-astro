import {queryOptions} from '@tanstack/react-query';

import {siteFetch} from '../platform/browser';
import {read} from './api';

/**
 * How ticket payments are taken (`/site-api/payment-settings`, src/server/routes/provider-admin.ts).
 * Typed by hand like the other feature query files. Keys: `['payment-settings', …]`.
 */

export type PaymentProvider = 'ezypay' | 'stripe' | 'paypal';

export type ProviderStatus = {
  provider: PaymentProvider;
  name: string;
  /** Which secret NAMES are set: booleans only, never a value. */
  secrets: {name: string; set: boolean}[];
  modeSetting: string | null;
  mode: 'test' | 'live' | null;
  ready: boolean;
  keyLooksWrong: boolean;
  modesDiffer: boolean;
  liveInPreview: boolean;
  webhookUrl: string;
  webhookEvents: string[];
  keySource: string;
};

export type PaymentSettings = {provider: PaymentProvider | null; preview: boolean; providers: ProviderStatus[]};

const BASE = '/site-api/payment-settings';

export const paymentSettingsQuery = queryOptions({
  queryKey: ['payment-settings'],
  queryFn: () => read<PaymentSettings>(siteFetch(BASE, {headers: {accept: 'application/json'}})),
});

export const savePaymentProvider = (provider: PaymentProvider | null) =>
  read<PaymentSettings>(siteFetch(BASE, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({provider})}));
