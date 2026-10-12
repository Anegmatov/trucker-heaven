import { useEffect } from 'react';
import { getSeoMetadata } from '../seo';

function upsertMeta(name, content) {
  let element = document.head.querySelector(`meta[name="${name}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute('name', name);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

export default function SeoMetadata({ path }) {
  useEffect(() => {
    const metadata = getSeoMetadata(path);
    document.title = metadata.title;
    upsertMeta('description', metadata.description);

    let canonical = document.head.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', metadata.canonical);

    const robots = document.head.querySelector('meta[name="robots"]');
    if (metadata.indexable) robots?.remove();
    else upsertMeta('robots', 'noindex, nofollow');
  }, [path]);

  return null;
}
