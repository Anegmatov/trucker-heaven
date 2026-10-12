export const menuSections = [
  {
    id: 'uzbek-specialties', title: 'Uzbek Specialties',
    items: [
      { name: "Plov 'Osh'", price: '$14.99', description: 'The crown jewel of Uzbek cuisine. Slow-simmered premium lamb, long-grain rice, sweet carrots, onions, and complex spices steamed together in a traditional cast-iron kazan.' },
      { name: 'Olot Samsa', price: '$7.99', description: 'Authentic Olot-style hand-rolled crispy pastry stuffed with finely minced seasoned beef, tail fat, and aromatic white onions, baked until absolute golden perfection.' },
      { name: 'Qovurma (Fried) Lagman', price: '$13.49', description: 'Thick hand-pulled house noodles pan-fried with tender beef slices, bell peppers, fresh garlic, cabbage, and traditional Central Asian spices.' },
    ],
  },
  {
    id: 'shawarma', title: 'Shawarma & Lavash',
    items: [
      { name: 'Beef Shawarma Plate', price: '$12.99', description: 'Shaved rotisserie beef seasoned with our special Mediterranean spice blend. Served with hummus, fresh shepherd salad, garlic sauce, and warm pita bread.' },
      { name: 'Chicken Shawarma Plate w/ Rice', price: '$13.99', description: 'Juicy, perfectly spiced shaved rotisserie chicken served over a bed of fragrant steamed basmati rice with garlic sauce and side salad.' },
      { name: 'Beef Lavash Sandwich', price: '$10.99', description: 'Traditional thin flatbread rolled with tender shaved beef, fresh sliced onions, tomatoes, French fries, and our signature red house sauce.' },
      { name: 'Mix Shawarma Plate w/ Rice', price: '$14.99', description: 'For the ultimate feast. Generous combination of our signature shaved beef and chicken shawarma served over rice with mixed sauces.' },
    ],
  },
  {
    id: 'burgers', title: 'Sherdor Gourmet Burgers',
    items: [
      { name: 'Sherdor Burger Combo', price: '$11.99', description: 'Gourmet prime beef patty grilled over open fire, topped with processed cheese, lettuce, tomatoes, red onions, house special sauce, served with crispy fries.' },
      { name: 'Sherdor Double Burger', price: '$10.99', description: 'Two flame-grilled beef patties loaded with melted double cheese, pickles, and our house sauce inside a soft brioche bun.' },
    ],
  },
  {
    id: 'hotdogs', title: 'Gourmet Hotdogs',
    items: [
      { name: 'Loaded Hot Dog', price: '$8.99', description: 'Jumbo all-beef premium link in a toasted bun, topped with seasoned beef bacon bits, melted cheddar sauce, jalapeños, onions, and house aioli.' },
    ],
  },
  {
    id: 'soups', title: 'Hearty Soups',
    items: [
      { name: 'Lagman Soup', price: '$12.99', description: 'Hearty, rich meat broth filled with hand-pulled noodles, tender beef chunks, turnip, radish, celery, and bell peppers, garnished with fresh cilantro.' },
      { name: 'Shurpa', price: '$12.99', description: 'Traditional clear broth soup with a massive piece of premium bone-in lamb, whole potato, sweet carrot, and soft chickpeas.' },
      { name: 'Chuchvara / Pelmeni', price: '$11.99', description: 'Dainty hand-pinched baby dumplings filled with seasoned beef and onions, boiled in a rich, piping hot clear meat broth.' },
      { name: 'Okroshka', price: '$9.99', description: 'Refreshing cold soup prepared with kefir, carbonated spring water, finely chopped cucumbers, radishes, hard-boiled eggs, and dill.' },
    ],
  },
  {
    id: 'desserts', title: 'Cakes & Desserts',
    items: [
      { name: 'Baklava', price: '$5.99', description: 'Rich, sweet pastry made of dozens of layers of flaky phyllo dough filled with chopped pistachios and sweetened with pure honey syrup.' },
      { name: 'Napoleon', price: '$6.99', description: 'Traditional Russian-style puff pastry cake layering dozens of crispy puff sheets with light, velvet-smooth vanilla custard cream.' },
    ],
  },
];

export const sidebarCategories = [
  ['Most Ordered', '4', 'most-ordered'],
  ...menuSections.map((section) => [section.title, String(section.items.length), section.id]),
];
