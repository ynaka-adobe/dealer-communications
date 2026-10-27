import { initConsent } from './consent.js';
import initAnalytics from './analytics.js';
import initInsights from './insights.js';

/**
 * Analytics runs in the delayed phase so it cannot affect LCP/CWV. Order matters: analytics
 * subscribes to consent first, then consent decides (implied unless the visitor said no). The
 * insights panel is a consumer of the same data layer and mounts once analytics is running.
 */
initAnalytics()
  .then(() => initInsights())
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[analytics] init failed', e);
  })
  .finally(() => {
    initConsent();
  });
