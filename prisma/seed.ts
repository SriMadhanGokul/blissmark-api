/*
 * Demo data for MongoDB, matching the designs and docs Appendix B.
 *   npx prisma db seed                 → only on an empty database
 *   SEED_RESET=1 npx prisma db seed    → wipes the Blissmark collections first
 * Inserts in batches (createMany) because the database is remote (Atlas).
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();
const img = (id: string, w = 600) => `https://images.unsplash.com/photo-${id}?w=${w}&q=70`;
const id = () => randomUUID().replace(/-/g, '').slice(0, 24);
const now = new Date();
const ago = (days: number, hours = 0) => new Date(Date.now() - days * 86400000 - hours * 3600000);
const lastMonth = (day: number) => new Date(now.getFullYear(), now.getMonth() - 1, day, 11, 0);
const monthKey = (offset: number) => {
  const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const FIRST = ['Neha', 'Karan', 'Meera', 'Rohit', 'Priya', 'Ankit', 'Sneha', 'Vikas', 'Pooja', 'Arjun', 'Kavya', 'Rahul', 'Isha', 'Manish', 'Divya', 'Sahil', 'Ritu', 'Aman', 'Tanya', 'Yash'];
const LAST = ['Verma', 'Singh', 'Joshi', 'Sharma', 'Gupta', 'Meena', 'Agarwal', 'Jain', 'Rathore', 'Saini', 'Choudhary', 'Mathur'];

async function reset() {
  // children before parents
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerJournal.deleteMany();
  await prisma.ledgerAccount.deleteMany();
  await prisma.orderEvent.deleteMany();
  await prisma.order.deleteMany();
  await prisma.bookingEvent.deleteMany();
  await prisma.booking.deleteMany();
  for (const m of [
    prisma.cartItem, prisma.ride, prisma.foodOrder, prisma.sosRequest, prisma.shortlist, prisma.enquiry, prisma.notification,
    prisma.withdrawal, prisma.subscription, prisma.incomeStatement, prisma.address, prisma.referralClosure,
  ] as unknown as { deleteMany: () => Promise<unknown> }[]) await m.deleteMany();
  await prisma.member.updateMany({ data: { sponsorId: null } });
  for (const m of [
    prisma.member, prisma.otp, prisma.user, prisma.product, prisma.category, prisma.seller, prisma.coupon, prisma.menuItem,
    prisma.restaurant, prisma.property, prisma.service, prisma.vendor,
  ] as unknown as { deleteMany: () => Promise<unknown> }[]) await m.deleteMany();
}

async function main() {
  if (await prisma.user.count()) {
    if (process.env.SEED_RESET !== '1') {
      console.log('Database already has data. Run with SEED_RESET=1 to wipe the Blissmark collections and reseed.');
      return;
    }
    await reset();
  }

  /* ---------- referral network: users, members and closure rows built in memory ---------- */
  type U = { id: string; phone: string; name: string | null; photo?: string; kycVerified?: boolean };
  type M = { id: string; userId: string; referralCode: string; sponsorId: string | null; active: boolean; joinedAt: Date };
  const users: U[] = [];
  const members: M[] = [];
  const closure: { id: string; ancestorId: string; descendantId: string; depth: number }[] = [];
  const ancestors = new Map<string, { id: string; depth: number }[]>();
  let phone = 7000000000;
  let codeSeq = 0;
  const add = (name: string | null, sponsorId: string | null, o: { phone?: string; code?: string; active?: boolean; joinedAt?: Date; photo?: string; kyc?: boolean } = {}) => {
    const u: U = { id: id(), phone: o.phone ?? String(phone++), name, photo: o.photo, kycVerified: o.kyc ?? false };
    const m: M = { id: id(), userId: u.id, referralCode: o.code ?? `BLISS-${(++codeSeq).toString(36).toUpperCase().padStart(6, 'X')}`, sponsorId, active: o.active ?? true, joinedAt: o.joinedAt ?? ago(30) };
    users.push(u);
    members.push(m);
    const up = sponsorId ? (ancestors.get(sponsorId) ?? []).filter((a) => a.depth < 30).map((a) => ({ id: a.id, depth: a.depth + 1 })) : [];
    const mine = [{ id: m.id, depth: 0 }, ...up];
    ancestors.set(m.id, mine);
    mine.forEach((a) => closure.push({ id: id(), ancestorId: a.id, descendantId: m.id, depth: a.depth }));
    return { u, m };
  };

  const hq = add('Blissmark', null, { phone: '9000000000', code: 'BLISS-HQ0001', joinedAt: ago(400) });
  const rahul = add('Rahul Sharma', hq.m.id, { phone: '9000000001', code: 'BLISS-R7K2M9', joinedAt: ago(300), photo: img('1507003211169-0a1dd7228f2d'), kyc: true });
  const aarav = add('Aarav Mehta', rahul.m.id, { phone: '9876543210', code: 'BLISS-A1B2C3', joinedAt: ago(200), photo: img('1500648767791-00dcc994a43e', 300), kyc: true });
  // Aarav's downline: L1 12 (9 active), L2 31 (19), L3 47 (22), L4 29 (11), L5 18 (3), then 11 inactive across L6+ = 148
  const plan: [number, number][] = [[12, 9], [31, 19], [47, 22], [29, 11], [18, 3]];
  const named = [['Neha Verma', 52, true], ['Karan Singh', 31, true], ['Meera Joshi', 16, false]] as const;
  let prev = [aarav.m.id];
  let n = 0;
  for (const [level, [count, active]] of plan.entries()) {
    const next: string[] = [];
    for (let i = 0; i < count; i++) {
      const isNamed = level === 0 && i < named.length;
      const { m } = add(isNamed ? named[i][0] : `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}`, prev[i % prev.length], {
        active: isNamed ? named[i][2] : i < active + (level === 0 ? 1 : 0),
        joinedAt: isNamed ? ago(named[i][1]) : ago(10 + ((n * 13) % 170)),
      });
      next.push(m.id);
      n++;
    }
    prev = next;
  }
  let tail = prev[0];
  for (let i = 0; i < 11; i++) tail = add(`${FIRST[(n + i) % FIRST.length]} ${LAST[(n + i) % LAST.length]}`, tail, { active: false, joinedAt: ago(5 + i) }).m.id;

  await prisma.user.createMany({ data: users });
  // insert members without sponsors, then link (a document can't reference one not yet inserted)
  await prisma.member.createMany({ data: members.map((m) => ({ ...m, sponsorId: null })) });
  const bySponsor = new Map<string, string[]>();
  members.filter((m) => m.sponsorId).forEach((m) => bySponsor.set(m.sponsorId!, [...(bySponsor.get(m.sponsorId!) ?? []), m.id]));
  for (const [sponsorId, ids] of bySponsor) await prisma.member.updateMany({ where: { id: { in: ids } }, data: { sponsorId } });
  await prisma.referralClosure.createMany({ data: closure });

  const uid = aarav.u.id;
  await prisma.address.createMany({
    data: [
      { id: id(), userId: uid, label: 'Home', line1: '12, Vaishali Nagar', city: 'Jaipur', pincode: '302021', isDefault: true, lat: 26.9124, lng: 75.7395 },
      { id: id(), userId: uid, label: 'Office', line1: '4th floor, World Trade Park, Malviya Nagar', city: 'Jaipur', pincode: '302017', isDefault: false, lat: 26.8535, lng: 75.8047 },
    ],
  });
  const home = { label: 'Home', line1: '12, Vaishali Nagar', city: 'Jaipur', pincode: '302021' };

  /* ---------- shopping ---------- */
  await prisma.category.createMany({
    data: [
      { id: 'electronics', name: 'Electronics', photo: img('1505740420928-5e560c06d30e', 300), sort: 1 },
      { id: 'fashion', name: 'Fashion', photo: img('1517677208171-0bc6725a3e60', 300), sort: 2 },
      { id: 'home', name: 'Home', photo: img('1556911220-bff31c812dba', 300), sort: 3 },
      { id: 'cleaning', name: 'Cleaning', photo: img('1563453392212-326f5e854473', 300), sort: 4 },
    ],
  });
  const sellers = { skyline: { id: id(), name: 'Skyline Traders', rating: 4.8 }, loom: { id: id(), name: 'Urban Loom', rating: 4.6 }, casa: { id: id(), name: 'Casa Living', rating: 4.7 } };
  await prisma.seller.createMany({ data: Object.values(sellers) });
  const colours = (list: [string, string][]) => list.map(([name, hex]) => ({ name, hex }));
  const products = [
    { id: id(), title: 'Aura Wireless Headphones', brand: 'Aura', categoryId: 'electronics', sellerId: sellers.skyline.id, price: 249900, mrp: 399900, rating: 4.6, reviews: 1284, photos: [img('1505740420928-5e560c06d30e', 900)], colours: colours([['Midnight', '#1D1A33'], ['Lavender', '#B7A6F2'], ['Sand', '#E9D3A8']]), trending: true, description: '40-hour battery, active noise cancelling and a soft memory-foam fit. Bluetooth 5.4 with fast pairing.' },
    { id: id(), title: 'Pulse Smart Watch', brand: 'Pulse', categoryId: 'electronics', sellerId: sellers.skyline.id, price: 329900, mrp: 499900, rating: 4.5, reviews: 860, photos: [img('1523275335684-37898b6baf30', 900)], colours: colours([['Silver', '#D9D9DE'], ['Midnight', '#1D1A33']]), trending: true, description: 'AMOLED display, heart-rate and SpO2 tracking, 7-day battery and 100+ sport modes.' },
    { id: id(), title: 'Knit Pullover', brand: 'Urban Loom', categoryId: 'fashion', sellerId: sellers.loom.id, price: 129900, mrp: 199900, rating: 4.4, reviews: 312, photos: [img('1517677208171-0bc6725a3e60', 900)], colours: colours([['Oat', '#E8DCC6'], ['Charcoal', '#3A3A40']]), trending: false, description: 'Soft cotton-wool blend pullover with a relaxed fit. Machine washable.' },
    { id: id(), title: 'Modular Kitchen Rack', brand: 'Casa', categoryId: 'home', sellerId: sellers.casa.id, price: 189900, mrp: 279900, rating: 4.3, reviews: 205, photos: [img('1556911220-bff31c812dba', 900)], colours: [], trending: true, description: 'Three-tier steel rack that fits most kitchen counters. Rust resistant.' },
    { id: id(), title: 'Bath Essentials Set', brand: 'Casa', categoryId: 'home', sellerId: sellers.casa.id, price: 99900, mrp: 149900, rating: 4.5, reviews: 441, photos: [img('1584622650111-993a426fbf0a', 900)], colours: [], trending: false, description: 'Soap dispenser, tumbler and tray in matte ceramic.' },
    { id: id(), title: 'Floating Wall Shelf', brand: 'Casa', categoryId: 'home', sellerId: sellers.casa.id, price: 149900, mrp: 229900, rating: 4.2, reviews: 96, photos: [img('1595515106969-1ce29566ff1c', 900)], colours: [], trending: false, description: 'Engineered wood shelf with hidden brackets. Holds up to 15 kg.' },
    { id: id(), title: 'Shine Multi-surface Cleaner', brand: 'Shine', categoryId: 'cleaning', sellerId: sellers.skyline.id, price: 62000, mrp: 79900, rating: 4.7, reviews: 2210, photos: [img('1563453392212-326f5e854473', 900)], colours: [], trending: true, description: 'Kills 99.9% of germs on tiles, glass and counters. Lemon fresh. 1 litre refill pack included.' },
  ];
  await prisma.product.createMany({ data: products });
  await prisma.coupon.createMany({
    data: [
      { code: 'SHOP10', description: '10% off up to ₹600 on orders above ₹999', percent: 10, maxDiscount: 60000, minOrder: 99900, vertical: 'shopping' },
      { code: 'FIRST10', description: '10% off your first home service', percent: 10, maxDiscount: 20000, minOrder: 0, vertical: 'services' },
    ],
  });

  /* ---------- services (all live) and providers ---------- */
  const services = [
    { code: 'plumber', label: 'Plumber', group: 'home', photo: img('1585704032915-c3400ca199e7', 500), issues: ['Leak', 'Blockage', 'Tap or fitting', 'Bathroom', 'Other'], visitCharge: 19900, requiresQuote: true },
    { code: 'parlour', label: 'Parlour & salon', group: 'home', photo: img('1522337360788-8b13dee7a37e', 500), issues: ['Haircut', 'Facial', 'Waxing', 'Bridal', 'Other'], visitCharge: 14900, requiresQuote: false },
    { code: 'ac', label: 'AC repair', group: 'home', photo: img('1621905251918-48416bd8575a', 500), issues: ['Not cooling', 'Service', 'Gas refill', 'Installation', 'Other'], visitCharge: 29900, requiresQuote: true },
    { code: 'laundry', label: 'Laundry', group: 'home', photo: img('1545173168-9f1947eebb7f', 500), issues: ['Wash and fold', 'Dry clean', 'Ironing', 'Other'], visitCharge: 4900, requiresQuote: false },
    { code: 'maid', label: 'Maid & cleaning', group: 'home', photo: img('1581578731548-c64695cc6952', 500), issues: ['Daily cleaning', 'Deep cleaning', 'Cooking', 'Other'], visitCharge: 9900, requiresQuote: false },
    { code: 'mechanic', label: 'Car mechanic', group: 'home', photo: img('1487754180451-c456f719a1fc', 500), issues: ['Not starting', 'Service', 'Brakes', 'Battery', 'Other'], visitCharge: 24900, requiresQuote: true },
    { code: 'labour', label: 'Labourer', group: 'home', photo: img('1504307651254-35680f356dfd', 500), issues: ['Loading', 'Construction', 'Shifting', 'Other'], visitCharge: 0, requiresQuote: false },
    { code: 'cab', label: 'Book a cab', group: 'rides', photo: img('1449965408869-eaa3f722e40d', 500), issues: [], visitCharge: 0, requiresQuote: false },
    { code: 'food', label: 'Food delivery', group: 'rides', photo: img('1504674900247-0877df9cc836', 500), issues: [], visitCharge: 0, requiresQuote: false },
    { code: 'kitchen', label: 'Cloud kitchen', group: 'rides', photo: img('1565299624946-b28f40a0ae38', 500), issues: [], visitCharge: 0, requiresQuote: false },
    { code: 'property', label: 'Homes for sale', group: 'property', photo: img('1568605114967-8130f3a36994', 500), issues: [], visitCharge: 0, requiresQuote: false },
    { code: 'highway', label: 'Highway SOS', group: 'emergency', photo: img('1600320254374-ce2d293c324e', 500), issues: ['Tow', 'Flat tyre', 'Out of fuel', 'Breakdown', 'Accident'], visitCharge: 0, requiresQuote: false },
    { code: 'health', label: 'Health SOS', group: 'emergency', photo: img('1587745416684-47953f16f02f', 500), issues: ['Breathing difficulty', 'Chest pain', 'Injury', 'Unconscious', 'Other'], visitCharge: 0, requiresQuote: false },
  ];
  await prisma.service.createMany({ data: services.map((s, i) => ({ ...s, sort: i, live: true })) });

  const person = ['1506794778202-cad84cf45f1d', '1472099645785-5658abf4ff4e', '1535713875002-d1d0cf377fde', '1599566150163-29194dcaad36', '1570295999919-56ceb5ecca61'];
  const vendors = [
    { id: id(), name: 'Ramesh Kumar', photo: img('1621905252507-b35492cc74b4', 300), rating: 4.8, jobs: 326, years: 6, services: ['plumber'] },
    { id: id(), name: 'Suresh Saini', photo: img('1504307651254-35680f356dfd', 300), rating: 4.6, jobs: 188, years: 4, services: ['plumber', 'labour'] },
    { id: id(), name: 'Imran Khan', photo: img('1621905251918-48416bd8575a', 300), rating: 4.7, jobs: 412, years: 8, services: ['ac'] },
    { id: id(), name: 'Glow Studio', photo: img('1522337360788-8b13dee7a37e', 300), rating: 4.9, jobs: 640, years: 5, services: ['parlour'] },
    { id: id(), name: 'Sunita Devi', photo: img('1581578731548-c64695cc6952', 300), rating: 4.7, jobs: 290, years: 7, services: ['maid'] },
    { id: id(), name: 'CleanPress', photo: img('1545173168-9f1947eebb7f', 300), rating: 4.5, jobs: 980, years: 3, services: ['laundry'] },
    { id: id(), name: 'Vikram Rathore', photo: img('1487754180451-c456f719a1fc', 300), rating: 4.6, jobs: 233, years: 9, services: ['mechanic'] },
    { id: id(), name: 'Manoj Yadav', photo: img(person[0], 300), rating: 4.9, jobs: 1840, years: 5, services: ['cab:sedan'], vehicle: 'Maruti Dzire · White', plate: 'RJ 14 CB 4821' },
    { id: id(), name: 'Deepak Meena', photo: img(person[1], 300), rating: 4.8, jobs: 2210, years: 7, services: ['cab:mini'], vehicle: 'Hyundai i20 · Silver', plate: 'RJ 14 CD 1093' },
    { id: id(), name: 'Raju Gurjar', photo: img(person[2], 300), rating: 4.7, jobs: 3120, years: 4, services: ['cab:auto'], vehicle: 'Bajaj RE Auto · Green', plate: 'RJ 14 PA 7720' },
    { id: id(), name: 'Sonu Prajapat', photo: img(person[3], 300), rating: 4.8, jobs: 2675, years: 3, services: ['cab:bike', 'rider'], vehicle: 'Honda Shine · Black', plate: 'RJ 14 SK 3381' },
    { id: id(), name: 'Arif Qureshi', photo: img(person[4], 300), rating: 4.9, jobs: 1420, years: 2, services: ['rider'], vehicle: 'TVS Jupiter · Blue', plate: 'RJ 14 SQ 5512' },
    { id: id(), name: 'Highway Rescue 24x7', photo: img('1600320254374-ce2d293c324e', 300), rating: 4.8, jobs: 860, years: 10, services: ['tow'], vehicle: 'Tow truck', plate: 'RJ 14 GT 0808' },
    { id: id(), name: 'LifeLine Ambulance', photo: img('1587745416684-47953f16f02f', 300), rating: 4.9, jobs: 1530, years: 12, services: ['ambulance'], vehicle: 'BLS Ambulance', plate: 'RJ 14 AM 1080' },
  ];
  await prisma.vendor.createMany({ data: vendors });

  /* ---------- food and cloud kitchens ---------- */
  const R = (rid: string, name: string, kind: 'restaurant' | 'kitchen', cuisine: string, photo: string, rating: number, ratings: number, etaMin: number, costForTwo: number, pureVeg: boolean, locality: string, sort: number) =>
    ({ id: rid, name, kind, cuisine, photo: img(photo, 800), rating, ratings, etaMin, costForTwo, pureVeg, locality, sort });
  await prisma.restaurant.createMany({
    data: [
      R('spice-route', 'Spice Route', 'restaurant', 'North Indian · Mughlai', '1585937421612-70a008356fbe', 4.5, 3200, 30, 60000, false, 'C-Scheme', 1),
      R('biryani-house', 'Biryani House', 'restaurant', 'Biryani · Hyderabadi', '1589302168068-964664d93dc0', 4.4, 5100, 35, 50000, false, 'Raja Park', 2),
      R('pizza-piazza', 'Pizza Piazza', 'restaurant', 'Pizza · Italian', '1513104890138-7c749659a591', 4.3, 2800, 25, 55000, true, 'Malviya Nagar', 3),
      R('burger-co', 'Burger Co.', 'restaurant', 'Burgers · Fast food', '1568901346375-23c9450c58cd', 4.2, 1900, 25, 40000, false, 'Vaishali Nagar', 4),
      R('green-bowl', 'Green Bowl', 'restaurant', 'Healthy · Salads', '1512621776951-a57141f2eefd', 4.6, 1200, 25, 45000, true, 'Tonk Road', 5),
      R('chaat-corner', 'Chaat Corner', 'restaurant', 'Street food · Snacks', '1601050690597-df0568f70950', 4.5, 6400, 20, 20000, true, 'MI Road', 6),
      R('tandoor-theory', 'Tandoor Theory', 'kitchen', 'Kebabs · Tandoor', '1567188040759-fb8a883dc6d8', 4.6, 2100, 35, 70000, false, 'Cloud kitchen · Jagatpura', 7),
      R('pasta-la-vista', 'Pasta La Vista', 'kitchen', 'Pasta · Continental', '1563379926898-05f4575a45d8', 4.4, 980, 35, 65000, false, 'Cloud kitchen · Mansarovar', 8),
      R('sweet-tooth', 'Sweet Tooth', 'kitchen', 'Desserts · Bakery', '1551024601-bec78aea704b', 4.7, 1500, 30, 35000, true, 'Cloud kitchen · C-Scheme', 9),
      R('fry-day', 'Fry Day', 'kitchen', 'Fried chicken · Wings', '1626645738196-c2a7c87a8f58', 4.3, 1300, 30, 50000, false, 'Cloud kitchen · Vaishali', 10),
    ],
  });
  type MI = [section: string, name: string, description: string, rupees: number, veg: boolean, bestseller?: boolean, photo?: string];
  const menus: Record<string, MI[]> = {
    'spice-route': [
      ['Mains', 'Paneer Butter Masala', 'Cottage cheese in a rich tomato-butter gravy', 289, true, true, '1565557623262-b51c2513a641'],
      ['Mains', 'Butter Chicken', 'Tandoor chicken in creamy makhani sauce', 349, false, true, '1631452180519-c014fe946bc7'],
      ['Mains', 'Dal Makhani', 'Black lentils slow-cooked overnight', 229, true],
      ['Breads', 'Butter Naan', 'Soft tandoor bread with butter', 59, true],
      ['Breads', 'Garlic Naan', 'Naan topped with roasted garlic', 69, true],
      ['Rice', 'Jeera Rice', 'Basmati tempered with cumin', 149, true],
    ],
    'biryani-house': [
      ['Biryani', 'Chicken Dum Biryani', 'Hyderabadi style, served with raita', 299, false, true, '1589302168068-964664d93dc0'],
      ['Biryani', 'Veg Dum Biryani', 'Seasonal vegetables and saffron rice', 249, true],
      ['Biryani', 'Mutton Biryani', 'Tender mutton, slow dum', 399, false],
      ['Sides', 'Mirchi ka Salan', 'Tangy chilli and peanut curry', 99, true],
    ],
    'pizza-piazza': [
      ['Pizza', 'Margherita', 'Tomato, mozzarella and basil', 249, true, true, '1513104890138-7c749659a591'],
      ['Pizza', 'Farmhouse', 'Onion, capsicum, mushroom and corn', 329, true],
      ['Pizza', 'Paneer Tikka Pizza', 'Tandoori paneer and peppers', 369, true],
      ['Sides', 'Garlic Bread', 'Toasted with herb butter', 129, true],
    ],
    'burger-co': [
      ['Burgers', 'Classic Chicken Burger', 'Crispy chicken, lettuce, mayo', 179, false, true, '1568901346375-23c9450c58cd'],
      ['Burgers', 'Aloo Tikki Burger', 'Spiced potato patty', 99, true],
      ['Burgers', 'Double Cheese Burger', 'Two patties, double cheese', 229, false],
      ['Sides', 'Peri Peri Fries', 'Crisp fries with peri peri', 109, true],
    ],
    'green-bowl': [
      ['Bowls', 'Grilled Chicken Bowl', 'Chicken, quinoa, greens, corn', 329, false, true, '1546069901-ba9599a7e63c'],
      ['Bowls', 'Rainbow Salad Bowl', 'Chickpeas, avocado, seasonal veg', 279, true, false, '1512621776951-a57141f2eefd'],
      ['Bowls', 'Greek Salad', 'Feta, olives, cucumber, tomato', 249, true, false, '1540189549336-e6e99c3679fe'],
    ],
    'chaat-corner': [
      ['Snacks', 'Samosa (2 pcs)', 'With mint and tamarind chutney', 49, true, true, '1601050690597-df0568f70950'],
      ['Snacks', 'Pav Bhaji', 'Butter pav with spiced vegetable mash', 129, true, false, '1606491956689-2ea866880c84'],
      ['Chaat', 'Raj Kachori', 'Crisp kachori with curd and chutneys', 99, true],
      ['Chaat', 'Pani Puri (8 pcs)', 'Spicy and sweet water', 69, true],
    ],
    'tandoor-theory': [
      ['Kebabs', 'Paneer Tikka', 'Charred paneer with peppers', 279, true, true, '1567188040759-fb8a883dc6d8'],
      ['Kebabs', 'Chicken Tikka', 'Smoky boneless chicken', 319, false],
      ['Kebabs', 'Seekh Kebab', 'Minced mutton skewers', 349, false],
      ['Platters', 'Tandoor Platter', 'Assorted kebabs for two', 699, false],
    ],
    'pasta-la-vista': [
      ['Pasta', 'Prawn Spaghetti', 'Garlic, chilli and cherry tomato', 449, false, true, '1563379926898-05f4575a45d8'],
      ['Pasta', 'Penne Arrabbiata', 'Spicy tomato sauce', 299, true],
      ['Pasta', 'Alfredo Fettuccine', 'Creamy parmesan sauce', 329, true],
    ],
    'sweet-tooth': [
      ['Desserts', 'Rainbow Donuts (3 pcs)', 'Glazed with sprinkles', 199, true, true, '1551024601-bec78aea704b'],
      ['Desserts', 'Raspberry Cream Cake (slice)', 'Fresh cream and berries', 179, true, false, '1565958011703-44f9829ba187'],
      ['Desserts', 'Chocolate Brownie', 'Warm, with fudge sauce', 149, true],
    ],
    'fry-day': [
      ['Chicken', 'Crispy Fried Chicken (4 pcs)', 'Southern style, hot and crispy', 349, false, true, '1626645738196-c2a7c87a8f58'],
      ['Chicken', 'Chicken Wings (6 pcs)', 'Tossed in peri peri', 279, false, false, '1626082927389-6cd097cdc6ec'],
      ['Sides', 'Coleslaw', 'Creamy cabbage salad', 79, true],
    ],
  };
  await prisma.menuItem.createMany({
    data: Object.entries(menus).flatMap(([restaurantId, items]) =>
      items.map(([section, name, description, rupees, veg, bestseller, photo]) => ({ id: id(), restaurantId, section, name, description, price: rupees * 100, veg, bestseller: !!bestseller, photo: photo ? img(photo, 400) : null })),
    ),
  });

  /* ---------- property ---------- */
  const P = (pid: string, title: string, type: string, bhk: number | null, areaSqft: number, lakhs: number, locality: string, photos: string[], amenities: string[], description: string, agentName: string, agentRating: number, days: number) =>
    ({ id: pid, title, type, bhk, areaSqft, price: Math.round(lakhs * 100000) * 100, locality, city: 'Jaipur', photos: photos.map((p) => img(p, 900)), amenities, description, agentName, agentRating, listedAt: ago(days) });
  await prisma.property.createMany({
    data: [
      P('prop-1', '3 BHK Villa with Pool', 'villa', 3, 2600, 185, 'Jagatpura', ['1564013799919-ab600027ffc6', '1600585154340-be6161a56a0c'], ['Private pool', 'Garden', 'Covered parking', '24x7 security'], 'Corner villa in a gated community, 5 min from the ring road. Modular kitchen and solar water heating.', 'Anil Agarwal', 4.8, 2),
      P('prop-2', 'Modern 4 BHK Independent House', 'villa', 4, 3400, 245, 'Malviya Nagar', ['1600596542815-ffad4c1539a9', '1512917774080-9991f1c4c750'], ['Terrace', 'Home office', 'Lift', 'Power backup'], 'Contemporary design with double-height living room and a rooftop terrace.', 'Kavita Jain', 4.7, 5),
      P('prop-3', '2 BHK Apartment near WTP', 'apartment', 2, 1150, 62, 'Malviya Nagar', ['1522708323590-d24dbb6b0267', '1545324418-cc1a3fa10c00'], ['Gym', 'Club house', 'Lift', 'Covered parking'], 'Bright east-facing flat on the 6th floor, walking distance to World Trade Park.', 'Rohit Saini', 4.6, 1),
      P('prop-4', '3 BHK Family Apartment', 'apartment', 3, 1650, 89, 'Vaishali Nagar', ['1560448204-e02f11c3d0e2', '1502672260266-1c1ef2d93688'], ['Kids play area', 'Lift', 'Visitor parking'], 'Spacious 3 BHK with two balconies, near Amrapali Circle.', 'Neha Mathur', 4.5, 8),
      P('prop-5', 'Garden House in C-Scheme', 'villa', 4, 4200, 420, 'C-Scheme', ['1568605114967-8130f3a36994', '1600585154340-be6161a56a0c'], ['Lawn', 'Servant quarter', 'Two car parking'], 'Classic bungalow on a quiet tree-lined lane in central Jaipur.', 'Anil Agarwal', 4.8, 12),
      P('prop-6', '1 BHK Starter Flat', 'apartment', 1, 640, 32, 'Mansarovar', ['1502672260266-1c1ef2d93688', '1545324418-cc1a3fa10c00'], ['Lift', 'Power backup'], 'Ideal first home or rental investment near the metro.', 'Rohit Saini', 4.6, 3),
      P('prop-7', 'Residential Plot, JDA Approved', 'plot', null, 2250, 54, 'Ajmer Road', ['1600596542815-ffad4c1539a9'], ['JDA approved', 'Corner plot', 'Wide road'], '250 sq yd plot in a developing JDA scheme with water and power lines in place.', 'Kavita Jain', 4.7, 6),
      P('prop-8', 'Luxury 4 BHK Penthouse', 'apartment', 4, 3900, 310, 'Tonk Road', ['1512917774080-9991f1c4c750', '1522708323590-d24dbb6b0267'], ['Private terrace', 'Jacuzzi', 'Concierge', 'Gym'], 'Top-floor penthouse with city views and a private terrace garden.', 'Neha Mathur', 4.5, 4),
      P('prop-9', '3 BHK Villa in Gated Society', 'villa', 3, 2200, 138, 'Vaishali Nagar', ['1564013799919-ab600027ffc6', '1568605114967-8130f3a36994'], ['Club house', 'Pool', 'Jogging track'], 'Ready-to-move villa with modular kitchen and two covered parkings.', 'Anil Agarwal', 4.8, 9),
    ],
  });

  /* ---------- Aarav's history ---------- */
  const shine = products[6];
  const pullover = products[2];
  await prisma.order.create({
    data: {
      id: 'BM47102', userId: uid, sellerName: 'Skyline Traders', status: 'DELIVERED', paymentMethod: 'upi', courier: 'SwiftShip Logistics', awb: 'EL8842190331',
      items: [{ productId: shine.id, title: shine.title, photo: shine.photos[0], colour: null, price: 62000, qty: 1 }],
      address: home, subtotal: 62000, deliveryFee: 0, total: 62000, placedAt: ago(2), expectedAt: ago(0),
      events: { create: [{ status: 'PLACED', note: 'Order placed', at: ago(2) }, { status: 'PACKED', note: 'Packed by seller', at: ago(2) }, { status: 'SHIPPED', note: 'Handed to courier', at: ago(1, 20) }, { status: 'OUT_FOR_DELIVERY', note: 'Out for delivery', at: ago(1, 4) }, { status: 'DELIVERED', note: 'Delivered', at: ago(1) }] },
    },
  });
  await prisma.order.create({
    data: {
      id: 'BM46550', userId: uid, sellerName: 'Urban Loom', status: 'CANCELLED', paymentMethod: 'upi',
      items: [{ productId: pullover.id, title: pullover.title, photo: pullover.photos[0], colour: 'Oat', price: 129900, qty: 1 }],
      address: home, subtotal: 129900, total: 129900, placedAt: lastMonth(17), expectedAt: lastMonth(20),
      events: { create: [{ status: 'PLACED', note: 'Order placed', at: lastMonth(17) }, { status: 'CANCELLED', note: 'Cancelled by you', at: lastMonth(18) }] },
    },
  });
  await prisma.booking.create({
    data: {
      id: 'SR19873', userId: uid, serviceCode: 'plumber', vendorId: vendors[0].id, status: 'CLOSED', issue: 'Leak', urgency: 'now', scheduledAt: lastMonth(12), description: 'Bathroom tap leaking continuously.', address: home, startCode: '7310', notified: 12, rating: 5,
      invoice: { number: 'INV-19873', lines: [{ label: 'Visit charge', amount: 19900 }, { label: 'Labour (1 hr)', amount: 35000 }, { label: 'Parts: P-trap pipe', amount: 28000 }, { label: 'Parts: sealant', amount: 6000 }], subtotal: 88900, gst: 16000, total: 104900, photos: 2 },
      createdAt: lastMonth(12), events: { create: [{ status: 'PAID', at: lastMonth(12) }, { status: 'CLOSED', at: lastMonth(12) }] },
    },
  });
  await prisma.ride.create({
    data: {
      id: 'CB30418', userId: uid, vehicle: 'mini', status: 'PAID', otp: '5521', paymentMethod: 'upi', rating: 5, distanceKm: 7.4, durationMin: 22,
      pickup: { label: 'Home', line1: '12, Vaishali Nagar, Jaipur', lat: 26.9124, lng: 75.7395 }, drop: { label: 'Jaipur Junction', line1: 'Railway Station, Gopalbari', lat: 26.9196, lng: 75.7878 },
      fare: { base: 5000, distance: 10400, time: 4400, total: 19800 },
      driver: { name: 'Deepak Meena', photo: img(person[1], 300), rating: 4.8, vehicle: 'Hyundai i20 · Silver', plate: 'RJ 14 CD 1093', trips: 2210 },
      events: [{ status: 'PAID', at: lastMonth(21) }], createdAt: lastMonth(21),
    },
  });
  await prisma.foodOrder.create({
    data: {
      id: 'FD52210', userId: uid, restaurantId: 'biryani-house', restaurantName: 'Biryani House', kind: 'restaurant', status: 'DELIVERED', paymentMethod: 'upi',
      items: [{ name: 'Chicken Dum Biryani', veg: false, price: 29900, qty: 2 }, { name: 'Mirchi ka Salan', veg: true, price: 9900, qty: 1 }],
      subtotal: 69700, taxes: 3500, deliveryFee: 0, total: 73200, address: home,
      rider: { name: 'Arif Qureshi', photo: img(person[4], 300), rating: 4.9, vehicle: 'TVS Jupiter · Blue', plate: 'RJ 14 SQ 5512' },
      events: [{ status: 'DELIVERED', at: lastMonth(26) }], createdAt: lastMonth(26),
    },
  });

  // wallet: payout + refund (withdrawable), withdrawal, subscription, a wallet-paid order → ₹1,250
  const accounts = new Map<string, string>();
  const acc = async (kind: string, ownerId: string | null) => {
    const k = `${kind}|${ownerId}`;
    if (!accounts.has(k)) accounts.set(k, (await prisma.ledgerAccount.create({ data: { kind, ownerId } })).id);
    return accounts.get(k)!;
  };
  const journal = async (type: string, title: string, at: Date, key: string, lines: { kind: string; ownerId?: string | null; debit?: number; credit?: number }[]) => {
    const j = await prisma.ledgerJournal.create({ data: { type, title, idempotencyKey: key, createdAt: at } });
    const entries = [];
    for (const l of lines) entries.push({ journalId: j.id, accountId: await acc(l.kind, l.ownerId ?? null), debit: l.debit ?? 0, credit: l.credit ?? 0 });
    await prisma.ledgerEntry.createMany({ data: entries });
  };
  await journal('payout', 'Income plan payout', lastMonth(5), 'seed:payout', [{ kind: 'income_pool', debit: 324000 }, { kind: 'wallet_withdrawable', ownerId: uid, credit: 324000 }]);
  await journal('subscription', 'Member subscription', lastMonth(1), 'seed:sub', [{ kind: 'wallet_withdrawable', ownerId: uid, debit: 9900 }, { kind: 'subscription_pool', credit: 9900 }]);
  await journal('withdrawal', 'Withdrawal to bank', lastMonth(8), 'seed:withdraw', [{ kind: 'wallet_withdrawable', ownerId: uid, debit: 200000 }, { kind: 'bank_payouts', credit: 200000 }]);
  await journal('refund', 'Refund: order BM46550', lastMonth(18), 'seed:refund', [{ kind: 'vendor_earnings', ownerId: 'seller:Urban Loom', debit: 129900 }, { kind: 'wallet_withdrawable', ownerId: uid, credit: 129900 }]);
  await journal('order', 'Order BM45218', lastMonth(24), 'seed:order', [{ kind: 'wallet_withdrawable', ownerId: uid, debit: 119000 }, { kind: 'vendor_earnings', ownerId: 'seller:Casa Living', credit: 119000 }]);
  await prisma.withdrawal.create({ data: { userId: uid, amount: 200000, tds: 0, net: 200000, bankLast4: '4821', status: 'paid', createdAt: lastMonth(8) } });

  const nextBilling = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  await prisma.subscription.createMany({
    data: [
      { id: id(), userId: uid, amount: 9900, status: 'active', autoRenew: true, nextBilling, history: [1, 2, 3].map((k) => ({ date: new Date(now.getFullYear(), now.getMonth() - k + 1, 1), amount: 9900, status: 'paid' })) },
      { id: id(), userId: rahul.u.id, amount: 9900, status: 'active', autoRenew: true, nextBilling, history: [] },
      { id: id(), userId: hq.u.id, amount: 9900, status: 'active', autoRenew: true, nextBilling, history: [] },
    ],
  });

  // Plan A statements: a month's payout is credited on the 5th of the next month.
  const stmt = (vals: number[]) => [...[10, 7, 6, 5, 4].map((pct, i) => ({ label: `Level ${i + 1}`, pct: `${pct}%`, amount: vals[i] })), { label: 'Levels 6 to 30', pct: '3% to 0.5%', amount: vals[5] }];
  const split = (total: number) => {
    const vals = [0.34, 0.235, 0.19, 0.125, 0.075, 0.035].map((s) => Math.round((total * s) / 100) * 100);
    vals[0] += total - vals.reduce((a, b) => a + b, 0);
    return vals;
  };
  const totals = [324000, 341000, 318000, 296000, 286000, 311000];
  await prisma.incomeStatement.createMany({
    data: totals.map((total, i) => ({
      id: id(),
      memberId: aarav.m.id,
      month: monthKey(i + 2),
      lines: stmt(i === 0 ? [110000, 76000, 62000, 41000, 25000, 10000] : split(total)),
      total,
      qualified: true,
      creditedAt: new Date(now.getFullYear(), now.getMonth() - i - 1, 5, 11),
    })),
  });

  await prisma.notification.createMany({
    data: [
      { id: id(), userId: uid, kind: 'order', title: 'Delivered', body: 'Shine Multi-surface Cleaner · #BM47102', link: '/orders/BM47102', createdAt: ago(1) },
      { id: id(), userId: uid, kind: 'payout', title: 'Income plan payout credited', body: '₹3,240 added to your wallet', link: '/income', createdAt: lastMonth(5) },
      { id: id(), userId: uid, kind: 'offer', title: 'Free delivery above ₹499', body: 'On your next shopping order. Auto applied.', link: '/shop', createdAt: ago(3) },
    ],
  });

  const counts = await Promise.all([prisma.member.count(), prisma.product.count(), prisma.service.count(), prisma.vendor.count(), prisma.restaurant.count(), prisma.menuItem.count(), prisma.property.count()]);
  console.log(`Seeded MongoDB: ${counts[0]} members, ${counts[1]} products, ${counts[2]} services, ${counts[3]} providers, ${counts[4]} restaurants/kitchens, ${counts[5]} menu items, ${counts[6]} properties`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
