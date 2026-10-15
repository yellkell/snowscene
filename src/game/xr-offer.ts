/**
 * Offering the headset's own "Enter VR" (Quest Browser's prompt) only once the baked world has loaded.
 * IWSDK's built-in offer (iwsdk.config.json `xr.offer`) fires the moment the world exists, before the
 * real graphics are in; it is off, and this offers instead when the guide says the world is ready. The
 * offered session goes through IWSDK's own launch path (World.launchXR adopts what requestSession
 * returns), and the offer is renewed whenever a session ends, as `offer: 'always'` did.
 */

import { buildSessionInit, SessionMode, type World } from '@iwsdk/core';

type OfferingXR = {
  offerSession?: (mode: XRSessionMode, init?: XRSessionInit) => Promise<XRSession>;
  requestSession: (mode: XRSessionMode, init?: XRSessionInit) => Promise<XRSession>;
};

let offering = false;

export function offerXR(world: World): void {
  const xr = navigator.xr as unknown as OfferingXR | undefined;
  if (!xr?.offerSession || offering || world.session) return;
  offering = true;
  const opts = world.xrDefaults ?? { sessionMode: SessionMode.ImmersiveVR };
  const mode = (opts.sessionMode ?? SessionMode.ImmersiveVR) as XRSessionMode;
  xr.offerSession(mode, buildSessionInit(opts))
    .then((session) => {
      offering = false;
      if (!session || world.session) return;
      session.addEventListener('end', () => setTimeout(() => offerXR(world), 0));
      // hand the offered session to IWSDK's launch path, which adopts whatever requestSession returns
      const real = xr.requestSession;
      xr.requestSession = () => Promise.resolve(session);
      try {
        world.launchXR();
      } finally {
        xr.requestSession = real;
      }
    })
    .catch(() => {
      offering = false;
    });
}
