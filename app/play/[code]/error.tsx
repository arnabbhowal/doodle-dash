'use client';

import SegmentError from '../../components/SegmentError';

export default function PlayError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <SegmentError {...props} />;
}
