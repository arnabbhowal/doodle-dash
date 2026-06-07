'use client';

import SegmentError from '../../components/SegmentError';

export default function HostError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <SegmentError {...props} />;
}
