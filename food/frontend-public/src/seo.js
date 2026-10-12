export const PRODUCTION_ORIGIN = 'https://silkroadgrilltn.com';

export const INDEXABLE_PAGES = [
  {
    path: '/',
    title: 'Silk Road Grill | Uzbek & International Food Truck in Mt. Juliet, TN',
    description: 'Silk Road Grill is an Uzbek & international food truck at Trucker Heaven in Mt. Juliet, Tennessee. Explore the menu, order online, or request catering.',
  },
  {
    path: '/menu',
    title: 'Menu | Silk Road Grill',
    description: 'Explore the menu from Silk Road Grill, an Uzbek & international food truck at Trucker Heaven in Mt. Juliet, Tennessee.',
  },
  {
    path: '/catering',
    title: 'Catering | Silk Road Grill',
    description: 'Request catering or a large pickup order from Silk Road Grill, an Uzbek & international food truck at Trucker Heaven in Mt. Juliet, Tennessee.',
  },
  {
    path: '/featured',
    title: 'Featured | Silk Road Grill',
    description: 'See featured dishes, menu additions, and stories from Silk Road Grill, an Uzbek & international food truck in Mt. Juliet, Tennessee.',
  },
  {
    path: '/about',
    title: 'About | Silk Road Grill',
    description: 'Learn about Silk Road Grill, an Uzbek & international food truck at Trucker Heaven in Mt. Juliet, Tennessee.',
  },
  {
    path: '/order',
    title: 'Order Online | Silk Road Grill',
    description: 'Order online for pickup from Silk Road Grill, an Uzbek & international food truck at Trucker Heaven in Mt. Juliet, Tennessee.',
  },
];

const indexableByPath = new Map(INDEXABLE_PAGES.map((page) => [page.path, page]));

export function getSeoMetadata(path) {
  const page = indexableByPath.get(path);
  if (page) return { ...page, canonical: `${PRODUCTION_ORIGIN}${page.path}`, indexable: true };

  return {
    ...indexableByPath.get('/'),
    canonical: `${PRODUCTION_ORIGIN}/`,
    indexable: false,
  };
}
