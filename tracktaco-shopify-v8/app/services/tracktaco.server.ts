/**
 * Live TrackTaco integration intentionally disabled until its actual spec is verified.
 * Never guess an endpoint or treat a tracking-request acceptance as successful shipment.
 */
export type TrackTacoResult = {trackingNumber: string; trackingUrl?: string; carrier?: string; requestId?: string};

export async function createTrackTacoFulfillment(_input: {
  shop: string;
  orderId: string;
  fulfillmentOrderIds: string[];
}): Promise<TrackTacoResult> {
  throw new Error("TrackTaco endpoint unverified. No fulfillment or charges were attempted.");
}
