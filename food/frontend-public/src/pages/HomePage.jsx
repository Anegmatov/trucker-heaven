import Header from '../components/Header';
import Footer from '../components/Footer';
import EditorialFoodVideo from '../components/EditorialFoodVideo';
import RealTruckSection from '../components/RealTruckSection';

const categoryRows = ['Uzbek Specialties', 'Kebabs & Grill', 'Burgers & Sandwiches', 'Breakfast', 'Soups & Sides', 'Drinks & Desserts', 'Specials'];

export default function HomePage() {
  return (
    <main className="home-page">
      <section className="hero" id="featured">
        <div className="hero-ambient" />
        <Header />
        <div className="hero-layout">
          <div className="hero-copy">
            <div className="hero-seal"><img src="/assets/silk-road-seal.jpg" alt="Silk Road Grill seal" /></div>
            <div className="hero-detail">
              <div className="short-rule" />
              <p className="hero-tagline">From the Silk Road to the open road.</p>
              <div className="long-rule" />
              <div className="hero-grill"><span>GRILL</span><b>AT TRUCKER HEAVEN</b></div>
              <p className="hero-cuisine">Uzbek &amp; International Food Truck</p>
              <div className="hero-actions"><a className="order-button squared" href="/menu">ORDER ONLINE</a><a className="outline-button squared" href="/menu">VIEW MENU</a></div>
              <div className="hero-badges"><span>FOOD TRUCK</span><i /> <span>ORDER AHEAD</span><i /> <span>PICKUP</span><i /> <span>DELIVERY</span><i /> <span>OUTDOOR SEATING</span></div>
              <p className="hero-address">8037 Eastgate Blvd, Mt. Juliet, TN 37122</p>
            </div>
          </div>
          <div className="hero-image"><img src="/assets/hero-food.png" alt="Uzbek plov and dishes arranged around a traditional plate" /></div>
        </div>
      </section>

      <RealTruckSection />

      <section className="most-ordered" id="about">
        <div className="section-heading"><b>FROM THE KITCHEN</b><h2>See what’s cooking.</h2><p>A closer look at the dishes and preparations coming out of Silk Road Grill.</p></div>
        <div className="kitchen-media-grid">
          <article><EditorialFoodVideo className="editorial-food-card editorial-food-uzbek" src="/assets/food-editorial-uzbek-cooking.mp4" poster="/assets/food-editorial-uzbek-cooking.jpg" label="Uzbek food cooking in a traditional kazan" /><h3>Uzbek Kitchen</h3><p>Fresh Uzbek food prepared in the truck, from sizzling pans to the final finishing touches.</p></article>
          <article><EditorialFoodVideo className="editorial-food-card editorial-food-lagman" src="/assets/food-editorial-lagman.mp4" poster="/assets/food-editorial-lagman.jpg" label="Lagman noodles being prepared in the Silk Road Grill kitchen" /><h3>Lagman Preparation</h3><p>Lagman being prepared fresh, with hand-pulled noodles and rich, savory flavor in every step.</p></article>
          <article><EditorialFoodVideo className="editorial-food-card editorial-food-crepes" src="/assets/food-editorial-crepes.mp4" poster="/assets/food-editorial-crepes.jpg" label="Fresh crepes being arranged in takeout containers" /><h3>Crepes for Takeaway</h3><p>Fresh crepes folded and packed to order for a quick, convenient meal on the go.</p></article>
        </div>
        <div className="section-divider" />
      </section>

      <section className="silk-statement"><div className="short-rule" /><div><h2>FROM THE SILK ROAD<br />TO THE OPEN ROAD.</h2><p>Uzbek roots. International favorites. Food made for drivers, travelers, and everyone passing through Trucker Heaven.</p></div></section>

      <section className="menu-intro"><div className="section-divider" /><h2>Explore the Menu</h2><p>Browse fast, order with confidence.</p><div className="menu-intro-grid">
        <div><h3>Shawarma &amp; Lavash</h3><p>Handheld, hearty, made to travel.</p></div><div><h3>Uzbek Specialties</h3><p>Plov, lagman, samsa and more.</p></div><div><h3>Charcoal Kebabs</h3><p>Fire, smoke and fresh-grilled flavor.</p></div><div><h3>Soups &amp; Sides</h3><p>Comforting bowls and shareable extras.</p></div>
      </div></section>

      <section className="menu-explorer"><b>EXPLORE THE MENU</b><div className="explorer-list">{categoryRows.map((name, index) => <a href="/menu" key={name}><span>{String(index + 1).padStart(2, '0')}</span><strong>{name}</strong><i>→</i></a>)}</div><a className="outline-button dark" href="/menu">VIEW FULL MENU</a></section>

      <section className="crew-section" id="catering"><div className="crew-layout"><div className="crew-copy"><div className="section-heading dark"><b>FEED YOUR CREW</b><h2>Feed Your Crew</h2><p>Bring Silk Road Grill to company lunches, driver and fleet meals, group orders, events at Trucker Heaven, and large pickup orders.</p></div><ul><li>Fleet &amp; company lunches</li><li>Driver groups</li><li>Large pickup orders</li><li>Trucker Heaven events</li><li>Custom catering inquiries</li></ul><div className="crew-cta"><b>CUSTOM CATERING INQUIRY · NO PACKAGES OR PRICES SHOWN YET</b><button className="pill-button">Request Catering</button></div></div><figure className="crew-media"><img src="/assets/catering-spread.jpg" alt="A shared spread of Central Asian pilaf, dumplings, and savory pastries for a group meal" /></figure></div><div className="section-divider" /></section>

      <section className="experience-section"><div className="section-heading"><b>FOOD TRUCK EXPERIENCE</b><h2>Made for the stop. Ready for the road.</h2><p>We operate as a food truck, designed for quick service and fresh air. Choose how you want to enjoy Silk Road Grill.</p></div><ul><li>Food Truck</li><li>Order Ahead</li><li>Pickup</li><li>Delivery</li><li>Outdoor Umbrella Seating</li></ul><div className="section-divider" /></section>

      <section className="visit-section" id="find-us"><div className="section-heading"><b>VISIT</b><h2>Find Silk Road Grill</h2><p>Part of Trucker Heaven. Order online, grab a seat under the umbrellas, or get directions.</p></div><div className="visit-address"><strong>8037 Eastgate Blvd</strong><span>Mt. Juliet, TN 37122</span><small>Hours, directions, phone and delivery links to be confirmed.</small></div><div className="visit-actions"><a className="pill-button" href="/menu">Order Online</a><button className="pill-button outline">Get Directions</button></div><div className="section-divider" /></section>
      <Footer compact />
    </main>
  );
}
