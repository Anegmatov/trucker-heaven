import { useEffect, useRef, useState } from 'react';

export default function EditorialFoodVideo({ src, poster, label, className = '' }) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const [reducedMotion, setReducedMotion] = useState(() => (
    typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(motionPreference.matches);

    motionPreference.addEventListener?.('change', updatePreference);
    return () => motionPreference.removeEventListener?.('change', updatePreference);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const video = videoRef.current;

    if (reducedMotion || !container || !video) return undefined;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }, { threshold: 0.25 });

    observer.observe(container);
    return () => observer.disconnect();
  }, [reducedMotion]);

  return (
    <div className={`editorial-food-media ${className}`} ref={containerRef}>
      {reducedMotion ? (
        <img src={poster} alt={label} />
      ) : (
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          muted
          playsInline
          loop
          preload="metadata"
          aria-label={label}
        />
      )}
    </div>
  );
}
