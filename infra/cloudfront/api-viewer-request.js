// CloudFront Function (cloudfront-js-2.0), viewer request on /api/* (K1, #244). Read as text by infra/src/web-stack.ts
// and by the site E2E stand-in (apps/alexa-sim/vite.cloudfront-preview.ts), so both run the same code.
// - /api/v1/turns reaches sim-api as /v1/turns;
// - the browser sends Origin on every POST, even same-origin: the site's own origin is dropped, so sim-api sees a
//   same-origin call; any other origin is refused here with 403;
// - x-viewer-ip carries the visitor's IP (the Function URL only sees CloudFront's edge), always overwritten; sim-api
//   trusts it only on a request that came through this distribution (#243).
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls the function by this name
function handler(event) {
  var request = event.request;
  var headers = request.headers;
  var host = headers.host ? headers.host.value : '';
  if (headers.origin) {
    if (headers.origin.value !== 'https://' + host) {
      return {
        statusCode: 403,
        statusDescription: 'Forbidden',
        headers: { 'content-type': { value: 'application/problem+json' } },
        body: { encoding: 'text', data: JSON.stringify({ type: 'about:blank', title: 'This origin may not call the demo.', status: 403, code: 'origin_not_allowed' }) },
      };
    }
    delete headers.origin;
  }
  headers['x-viewer-ip'] = { value: event.viewer.ip };
  request.uri = request.uri.replace(/^\/api(?=\/|$)/, '') || '/';
  return request;
}
