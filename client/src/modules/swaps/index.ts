import type { Send } from '../../core/http.js';
import { listSwapActivity } from './activity.js';
import { prepareSwapCancellation, submitSwapCancellation } from './cancel.js';
import { getSwap } from './get.js';
import { prepareSwap } from './prepare.js';
import { quoteSwap } from './quote.js';
import { submitSwap } from './submit.js';
import type { SwapsApi } from './types.js';

export function createSwapsApi(send: Send): SwapsApi {
  return {
    quote: (input, options) => quoteSwap(send, input, options),
    prepare: (input, options) => prepareSwap(send, input, options),
    submit: (input, options) => submitSwap(send, input, options),
    get: (swapId, options) => getSwap(send, swapId, options),
    prepareCancellation: (swapId, options) => prepareSwapCancellation(send, swapId, options),
    submitCancellation: (swapId, input, options) =>
      submitSwapCancellation(send, swapId, input, options),
    activity: (query, options) => listSwapActivity(send, query, options),
  };
}

export type { SwapsApi } from './types.js';
