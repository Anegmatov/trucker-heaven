import { useEffect, useState } from 'react';

export default function MediaImage({ src, alt = '', ...props }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return null;
  return <img src={src} alt={alt} onError={() => setFailed(true)} {...props} />;
}
