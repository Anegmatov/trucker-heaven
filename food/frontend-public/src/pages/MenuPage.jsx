import { useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import MediaImage from '../components/MediaImage';
import ItemOptionsDialog from '../components/ItemOptionsDialog';
import { menuSections } from '../data/menu';
import { useCart } from '../state/cart/CartContext';
import { loadPublicMenu, resolveMediaUrl } from '../lib/foodops';

const formatPrice = (cents) => `$${(cents / 100).toFixed(2)}`;
const mapLiveMenu = (items) => menuSections.map((reference) => ({ ...reference, items: items
  .filter((item) => item.categorySlug === reference.id)
  .map((item) => ({ id: item.id, menuItemId: item.id, name: item.name,
    description: item.description, price: formatPrice(item.priceCents), image: resolveMediaUrl(item.imagePath),
    priceCents: item.priceCents, available: item.isAvailable, featured: item.isFeatured,
    modifierGroups: item.modifierGroups || [] })) })).filter((section) => section.items.length);

function MenuCard({ item, onAdd }) {
  return (
    <article className={`menu-card ${item.image ? 'with-image' : ''}`}>
      <div className="card-copy"><div className="card-title"><h3>{item.name}</h3><strong>{item.price}</strong></div><p>{item.description}</p><div className="card-footer"><div className="tags"><span>HALAL</span><span>{item.available ? 'FRESH' : 'SOLD OUT'}</span></div><button className="menu-add-button" type="button" onClick={() => onAdd(item)} disabled={!item.available}>{item.available ? 'ADD +' : 'SOLD OUT'}</button></div></div>
      <MediaImage src={item.image} alt={item.name} />
    </article>
  );
}

function FeaturedItem({ item, onAdd }) {
  return (
    <article className={`featured-menu-item ${item.image ? 'with-image' : 'without-image'}`}>
      <MediaImage src={item.image} alt={item.name} />
      <div className="featured-menu-copy"><h3>{item.name}</h3><strong>{item.price}</strong></div>
      <button type="button" onClick={() => onAdd(item)} disabled={!item.available} aria-label={item.available ? `Add ${item.name} to cart` : `${item.name} is sold out`}>{item.available ? '+' : 'SOLD OUT'}</button>
    </article>
  );
}

export default function MenuPage() {
  const [activeCategory, setActiveCategory] = useState('most-ordered');
  const [sections, setSections] = useState(null);
  const [menuError, setMenuError] = useState('');
  const [optionsItem, setOptionsItem] = useState(null);
  const { addItem } = useCart();
  const addFromMenu = (item) => item.modifierGroups?.length ? setOptionsItem(item) : addItem(item);
  const addWithOptions = (item, options) => { addItem(item, options); setOptionsItem(null); };
  const featuredItems = useMemo(() => {
    const items = (sections || []).flatMap((section) => section.items);
    return items.filter((item) => item.featured)
      .filter(Boolean);
  }, [sections]);
  const sidebarCategories = useMemo(() => [
    ['Most Ordered', String(featuredItems.length), 'most-ordered'],
    ...(sections || []).map((section) => [section.title, String(section.items.length), section.id]),
  ], [featuredItems.length, sections]);

  useEffect(() => {
    let active = true;
    loadPublicMenu().then(({ items }) => { if (active) setSections(mapLiveMenu(items)); })
      .catch((error) => { if (active) setMenuError(error.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const sectionNodes = sidebarCategories
      .map(([, , target]) => document.getElementById(target))
      .filter(Boolean);

    const updateActive = () => {
      const offset = window.innerWidth <= 840 ? 136 : 116;
      let current = sectionNodes[0]?.id || 'most-ordered';
      sectionNodes.forEach((section) => {
        if (section.getBoundingClientRect().top <= offset) current = section.id;
      });
      setActiveCategory(current);
    };

    updateActive();
    window.addEventListener('scroll', updateActive, { passive: true });
    window.addEventListener('resize', updateActive);
    return () => {
      window.removeEventListener('scroll', updateActive);
      window.removeEventListener('resize', updateActive);
    };
  }, [sections]);

  return (
    <main className="menu-page">
      <Header />
      <div className="menu-shell">
        <aside className="category-sidebar"><div className="sidebar-sticky"><label className="menu-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search menu" aria-label="Search menu" /></label><label className="mobile-category-select"><span>Category</span><select value={activeCategory} onChange={(event) => { setActiveCategory(event.target.value); window.location.hash = event.target.value; }} aria-label="Menu category">{sidebarCategories.map(([name, , target]) => <option value={target} key={target}>{name}</option>)}</select></label><nav aria-label="Menu categories">{sidebarCategories.map(([name, count, target]) => <a className={activeCategory === target ? 'active' : ''} href={`#${target}`} key={target}><span>{name}</span><b>{count}</b></a>)}</nav><div className="halal-note"><strong>100% Halal Meats</strong><p>All our specialties are prepared strictly according to authentic Zabiha Halal guidelines.</p></div></div></aside>
        <div className="menu-content">
          <section className="menu-top-info"><h1>Silk Road Grill Menu</h1><p className="menu-context">Silk Road Grill · Uzbek &amp; International Food Truck at Trucker Heaven</p><p>8037 Eastgate Blvd, Mt. Juliet, TN 37122</p><div className="utility-row"><a href="#most-ordered">Pickup</a><a href="#most-ordered">Delivery</a><a href="#most-ordered">Order Ahead</a></div></section>
          {menuError ? <section className="menu-category"><div className="category-title"><h2>Menu unavailable</h2><span /></div><p className="form-error" role="alert">{menuError}</p></section> : !sections ? <section className="menu-category"><div className="category-title"><h2>Loading menu</h2><span /></div></section> : <><section className="most-ordered-menu menu-category" id="most-ordered"><div className="category-title"><h2>Most Ordered</h2><span /></div><div className="featured-menu-grid">{featuredItems.map((item) => <FeaturedItem item={item} onAdd={addFromMenu} key={item.id} />)}</div></section>{sections.map(section => <section className="menu-category" id={section.id} key={section.id}><div className="category-title"><h2>{section.title}</h2><span /></div><div className="category-ornament"><i /><b /><i /></div><div className="items-grid">{section.items.map(item => <MenuCard item={item} onAdd={addFromMenu} key={item.id} />)}</div></section>)}</>}
        </div>
      </div>
      {optionsItem && <ItemOptionsDialog item={optionsItem} onClose={() => setOptionsItem(null)} onConfirm={addWithOptions} />}
      <Footer />
    </main>
  );
}
