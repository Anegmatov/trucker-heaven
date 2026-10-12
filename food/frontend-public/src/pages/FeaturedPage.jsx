import { useEffect, useState } from 'react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import MediaImage from '../components/MediaImage';
import ItemOptionsDialog from '../components/ItemOptionsDialog';
import { loadPublicMenu, resolveMediaUrl } from '../lib/foodops';
import { useCart } from '../state/cart/CartContext';

const formatPrice = (priceCents) => `$${(Number(priceCents || 0) / 100).toFixed(2)}`;

function toCartItem(item) {
  return {
    id: item.id,
    menuItemId: item.id,
    name: item.name,
    description: item.description,
    price: formatPrice(item.priceCents),
    priceCents: item.priceCents,
    image: resolveMediaUrl(item.imagePath),
    available: item.isAvailable,
    modifierGroups: item.modifierGroups || [],
  };
}

function FeaturedDish({ item, prominent, added, onAdd }) {
  const hasImage = Boolean(item.image);

  return (
    <article className={`featured-live-item${prominent ? ' prominent' : ''}${hasImage ? '' : ' text-only'}`}>
      <MediaImage src={item.image} alt={item.name} />
      <div className="featured-live-copy">
        <b>{prominent ? 'FEATURED DISH' : 'FROM THE MENU'}</b>
        {prominent ? <h2>{item.name}</h2> : <h3>{item.name}</h3>}
        {item.description ? <p>{item.description}</p> : null}
        <strong>{item.price}</strong>
        <button
          type="button"
          className="figma-button"
          disabled={!item.available}
          onClick={() => onAdd(item)}
        >
          {!item.available ? 'SOLD OUT' : added ? 'ADDED' : 'ADD +'}
        </button>
      </div>
    </article>
  );
}

export default function FeaturedPage() {
  const { addItem } = useCart();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [optionsItem, setOptionsItem] = useState(null);
  const [addedId, setAddedId] = useState(null);

  useEffect(() => {
    let active = true;

    loadPublicMenu()
      .then((menu) => {
        if (!active) return;
        const featured = (menu.items || [])
          .filter((item) => item.isFeatured && item.isVisible !== false)
          .map(toCartItem);
        setItems(featured);
      })
      .catch(() => {
        if (!active) return;
        setItems([]);
        setError('Featured dishes could not be loaded.');
      });

    return () => { active = false; };
  }, []);

  function showAdded(itemId) {
    setAddedId(itemId);
    window.setTimeout(() => setAddedId((current) => current === itemId ? null : current), 1600);
  }

  function handleAdd(item) {
    if (!item.available) return;
    if (item.modifierGroups.length) {
      setOptionsItem(item);
      return;
    }
    addItem(item);
    showAdded(item.id);
  }

  function handleConfirmOptions(item, options) {
    addItem(item, options);
    showAdded(item.id);
    setOptionsItem(null);
  }

  return (
    <main className="editorial-page featured-page">
      <Header showSignIn={false} />
      <section className="featured-intro">
        <div className="featured-intro-copy">
          <b>FEATURED</b>
          <h1>From our kitchen to your table.</h1>
          <p>Selected dishes, gatherings, and a closer look at the Silk Road Grill experience at Trucker Heaven.</p>
        </div>
        <figure className="featured-intro-media">
          <img src="/assets/silk-road-featured-food-spread.png" alt="A shared Uzbek food spread at Silk Road Grill" />
        </figure>
      </section>

      <section className="featured-live-section" aria-live="polite">
        {items === null ? <p className="featured-state">Loading featured dishes…</p> : null}
        {error ? <p className="featured-state featured-error">{error}</p> : null}
        {items?.length === 0 && !error ? (
          <div className="featured-empty">
            <h2>Nothing featured right now.</h2>
            <a href="/menu">Explore the full menu →</a>
          </div>
        ) : null}
        {items?.length ? (
          <>
            <FeaturedDish item={items[0]} prominent added={addedId === items[0].id} onAdd={handleAdd} />
            {items.length > 1 ? (
              <div className="featured-live-grid">
                {items.slice(1).map((item) => (
                  <FeaturedDish key={item.id} item={item} added={addedId === item.id} onAdd={handleAdd} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="plov-story-section" aria-labelledby="plov-story-title">
        <div className="plov-story-copy">
          <b>UZBEK SPECIALTY</b>
          <i aria-hidden="true" />
          <h2 id="plov-story-title">Plov, the heart of our kitchen.</h2>
          <p>Plov, also known as Osh, is one of the defining dishes of Uzbek cuisine — rice cooked with meat, carrots, onions, and aromatic spices until every part comes together in one rich, deeply comforting dish.</p>
          <p>For Silk Road Grill, Plov represents the food we want people to remember: generous, familiar, and rooted in Uzbek cooking. It is more than another item on the menu — it is one of the dishes at the center of who we are.</p>
          <span>UZBEK PLOV · SLOW-COOKED · SILK ROAD SIGNATURE</span>
          <a className="plov-story-link" href="/menu">VIEW MENU <em>→</em></a>
        </div>
        <figure className="plov-story-image">
          <img src="/assets/silk-road-plov-editorial.png" alt="Silk Road Grill Uzbek Plov with rice, lamb, carrots, chickpeas, and raisins" />
        </figure>
      </section>

      <section className="featured-location-section" aria-labelledby="trucker-heaven-title">
        <div className="featured-location-copy">
          <b>AT TRUCKER HEAVEN</b>
          <i aria-hidden="true" />
          <h2 id="trucker-heaven-title">Pull in. Grab a seat. Stay awhile.</h2>
          <p>Silk Road Grill is a food truck at Trucker Heaven in Mt. Juliet, with outdoor seating for a quick stop, a meal outside, or something to take back on the road.</p>
          <strong>8037 Eastgate Blvd · Mt. Juliet, Tennessee</strong>
          <span>FOOD TRUCK · OUTDOOR SEATING · PICKUP · ORDER AHEAD</span>
          <div className="featured-location-actions">
            <a className="featured-location-link" href="https://www.google.com/maps/search/?api=1&amp;query=8037+Eastgate+Blvd+Mt.+Juliet+TN+37122">GET DIRECTIONS ↗</a>
            <a className="featured-location-link muted" href="/menu">ORDER ONLINE →</a>
          </div>
        </div>
        <div className="featured-location-gallery">
          <figure className="location-photo location-primary"><img src="/assets/silk-road-location-day-overview.png" alt="Silk Road Grill food truck and outdoor patio seating at Trucker Heaven" /></figure>
          <figure className="location-photo location-night-truck"><img src="/assets/silk-road-truck-night-01.png" alt="Silk Road Grill food truck and patio lit at night" /></figure>
          <figure className="location-photo location-day-patio-one"><img src="/assets/silk-road-patio-day-01.png" alt="Outdoor seating and umbrellas beside Silk Road Grill" /></figure>
          <figure className="location-photo location-day-patio-two"><img src="/assets/silk-road-patio-day-02.png" alt="Silk Road Grill truck behind its outdoor seating area" /></figure>
          <figure className="location-photo location-day-truck"><img src="/assets/silk-road-truck-day-01.png" alt="Silk Road Grill truck and outdoor dining in daylight" /></figure>
          <figure className="location-photo location-night-patio"><img src="/assets/silk-road-patio-night-01.png" alt="Outdoor tables at Silk Road Grill lit at night" /></figure>
          <figure className="location-photo location-night-detail"><img src="/assets/silk-road-patio-night-02.png" alt="Silk Road Grill outdoor seating facing Trucker Heaven at night" /></figure>
        </div>
      </section>

      <section className="featured-menu-cta">
        <b>EXPLORE THE FULL MENU</b>
        <h2>See everything we’re serving.</h2>
        <a className="outline-button dark" href="/menu">VIEW FULL MENU →</a>
      </section>

      <Footer simple />
      {optionsItem ? (
        <ItemOptionsDialog
          item={optionsItem}
          onClose={() => setOptionsItem(null)}
          onConfirm={handleConfirmOptions}
        />
      ) : null}
    </main>
  );
}
