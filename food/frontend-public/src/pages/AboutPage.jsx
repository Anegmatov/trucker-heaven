import Header from '../components/Header';
import Footer from '../components/Footer';

export default function AboutPage() {
  return (
    <main className="editorial-page about-page">
      <Header showSignIn={false} />
      <section className="editorial-dark-hero about-hero"><div><b>ABOUT SILK ROAD GRILL</b><h1>From the Silk Road to the open road.</h1><p>Silk Road Grill is a food truck at Trucker Heaven serving Uzbek and international food for drivers, travelers, neighbors, and everyone passing through.</p></div><img src="/assets/hero-food.png" alt="A table filled with Uzbek dishes" /></section>
      <section className="about-story"><div><b>OUR PLACE</b><h2>Food for the stop — and the road ahead.</h2><p>The site should tell the real story of the food truck, the prep, the people behind the window, and how Silk Road fits into Trucker Heaven. We will replace this placeholder copy with the real story when you provide it.</p></div><div className="production-media" data-required-source="The place, where the Silk Road begins.webm"><b>SELECTED FOOTAGE — SILK ROAD / CHORSU</b><p>The place, where the Silk Road begins.webm · Chorsu bazaar, Uzbekistan · 1280×960 · 1:02<br />Use only as Uzbek-culture/heritage B-roll — do NOT imply this is our Mt. Juliet location.<br />Source: Wikimedia Commons · CC BY-SA 4.0 · credit required<br />https://commons.wikimedia.org/wiki/File:The_place,_where_the_Silk_Road_begins.webm</p></div></section>
      <section className="defines-section"><h2>What defines Silk Road</h2><div>{[
        ['01', 'Uzbek roots', 'The identity starts with Uzbek food and Silk Road influence.'],
        ['02', 'International favorites', 'The menu also serves familiar food for a broad range of travelers.'],
        ['03', 'Made for the road', 'A practical food-truck experience: order ahead, pickup, delivery, and outdoor seating.'],
      ].map(([number, title, copy]) => <article key={number}><b>{number}</b><h3>{title}</h3><p>{copy}</p></article>)}</div></section>
      <section className="visit-cta"><b>VISIT SILK ROAD</b><h2>Find us at Trucker Heaven.</h2><p>8037 Eastgate Blvd · Mt. Juliet, TN 37122</p><div><a className="figma-button" href="/menu">VIEW MENU</a><a className="figma-button outline" href="/menu">ORDER ONLINE</a></div></section>
      <Footer simple />
    </main>
  );
}
