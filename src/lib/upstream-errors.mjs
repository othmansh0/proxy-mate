const ERROR_TAG = /^passthrough-error:(E[A-Z0-9_]{1,79}|CERT_[A-Z0-9_]{1,75}|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z0-9_]{1,70}|mockttp-abort)$/;
const TLS_TAG = /^passthrough-tls-error:(context-unsupported|context-unknown|ssl-alert-\d{1,3})$/;

export function upstreamErrorTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.slice(0, 32).flat(1).filter((tag) =>
    typeof tag === 'string' && (ERROR_TAG.test(tag) || TLS_TAG.test(tag))))].slice(0, 16);
}

export function upstreamErrorFromTags(tags) {
  const safe = upstreamErrorTags(tags);
  const code = safe.map((tag) => ERROR_TAG.exec(tag)?.[1]).find((value) => value && value !== 'mockttp-abort');
  if (!code) return null;
  return { source: 'proxy', code, message: 'The proxy could not complete the upstream connection.' };
}

export function upstreamErrorDiagnostic(event) {
  if (event?.eventType !== 'passthrough-abort' || event.eventData?.downstreamAborted === true) return null;
  if (typeof event.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.requestId)) return null;
  const data = event.eventData ?? {};
  const tags = upstreamErrorTags([...(Array.isArray(data.tags) ? data.tags : []), `passthrough-error:${data.error?.code}`]);
  return {
    id: event.requestId,
    error_name: data.error?.name === 'AggregateError' ? 'AggregateError' : 'Error',
    ...(upstreamErrorFromTags(tags) ?? { source: 'proxy', code: 'UPSTREAM_CONNECTION_FAILED',
      message: 'The proxy could not complete the upstream connection.' }),
    tags,
  };
}
