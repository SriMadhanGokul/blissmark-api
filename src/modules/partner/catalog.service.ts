import { Injectable } from '@nestjs/common';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { code } from '../../common/util';
import { PartnerService } from './partner.service';

type Photo = string | undefined;

/** Photos come from the gallery as compressed JPEG data URIs, or as https links. */
function checkPhoto(p: Photo, field = 'photo') {
  if (!p) return;
  const ok = (p.startsWith('data:image/') && p.length <= 600000) || /^https:\/\//.test(p);
  if (!ok) throw invalid('PHOTO', 'That photo is too large. Pick a smaller one.', field);
}
const money = (n: unknown, field: string, label: string) => {
  if (!Number.isInteger(n) || (n as number) <= 0) throw invalid('PRICE', `Enter a valid ${label}`, field);
  return n as number;
};

/** Category-specific catalogs: seller products, restaurant menu, agent listings. */
@Injectable()
export class CatalogService {
  constructor(
    private prisma: PrismaService,
    private partner: PartnerService,
  ) {}

  /* ---------------- seller: products & inventory ---------------- */

  private async seller(userId: string) {
    const v = await this.partner.vendor(userId);
    if (v.category !== 'seller' || !v.sellerId) throw invalid('CATEGORY', 'Only sellers have a product catalog');
    return v;
  }

  categories() {
    return this.prisma.category.findMany({ orderBy: { sort: 'asc' }, select: { id: true, name: true } });
  }

  async products(userId: string) {
    const v = await this.seller(userId);
    return this.prisma.product.findMany({ where: { sellerId: v.sellerId! }, include: { category: { select: { name: true } } }, orderBy: { title: 'asc' } });
  }

  async addProduct(userId: string, p: { title: string; brand?: string; description: string; categoryId: string; price: number; mrp: number; stock: number; photo?: string }) {
    const v = await this.seller(userId);
    if (!p.title || p.title.trim().length < 3) throw invalid('TITLE', 'Enter the product name', 'title');
    if (!p.description || p.description.trim().length < 10) throw invalid('DESCRIPTION', 'Describe the product in a sentence', 'description');
    if (!(await this.prisma.category.findUnique({ where: { id: p.categoryId } }))) throw invalid('CATEGORY', 'Choose a category', 'categoryId');
    const price = money(p.price, 'price', 'selling price');
    const mrp = money(p.mrp, 'mrp', 'MRP');
    if (mrp < price) throw invalid('MRP', 'MRP cannot be lower than the selling price', 'mrp');
    if (!Number.isInteger(p.stock) || p.stock < 0) throw invalid('STOCK', 'Enter the stock you have', 'stock');
    checkPhoto(p.photo);
    await this.prisma.product.create({
      data: {
        title: p.title.trim(),
        brand: p.brand?.trim() || null,
        description: p.description.trim(),
        categoryId: p.categoryId,
        sellerId: v.sellerId!,
        price,
        mrp,
        stock: p.stock,
        rating: 0,
        reviews: 0,
        photos: [p.photo ?? 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=900&q=70'],
        active: true,
      },
    });
    return this.products(userId);
  }

  async editProduct(userId: string, id: string, p: { price?: number; mrp?: number; stock?: number; active?: boolean }) {
    const v = await this.seller(userId);
    const prod = await this.prisma.product.findFirst({ where: { id, sellerId: v.sellerId! } });
    if (!prod) throw notFound('Product');
    const price = p.price !== undefined ? money(p.price, 'price', 'selling price') : prod.price;
    const mrp = p.mrp !== undefined ? money(p.mrp, 'mrp', 'MRP') : prod.mrp;
    if (mrp < price) throw invalid('MRP', 'MRP cannot be lower than the selling price', 'mrp');
    if (p.stock !== undefined && (!Number.isInteger(p.stock) || p.stock < 0)) throw invalid('STOCK', 'Enter the stock you have', 'stock');
    await this.prisma.product.update({ where: { id }, data: { price, mrp, ...(p.stock !== undefined ? { stock: p.stock } : {}), ...(p.active !== undefined ? { active: p.active } : {}) } });
    return this.products(userId);
  }

  /* ---------------- restaurant: menu & prep settings ---------------- */

  private async kitchen(userId: string) {
    const v = await this.partner.vendor(userId);
    if (v.category !== 'restaurant' || !v.restaurantId) throw invalid('CATEGORY', 'Only restaurants have a menu');
    return v;
  }

  async menu(userId: string) {
    const v = await this.kitchen(userId);
    const [restaurant, items] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: v.restaurantId! } }),
      this.prisma.menuItem.findMany({ where: { restaurantId: v.restaurantId! }, orderBy: [{ section: 'asc' }, { name: 'asc' }] }),
    ]);
    return { restaurant, items };
  }

  async addItem(userId: string, m: { section: string; name: string; description: string; price: number; veg: boolean; photo?: string }) {
    const v = await this.kitchen(userId);
    if (!m.name || m.name.trim().length < 2) throw invalid('NAME', 'Enter the dish name', 'name');
    if (!m.section?.trim()) throw invalid('SECTION', 'Enter a menu section, like Starters', 'section');
    checkPhoto(m.photo);
    await this.prisma.menuItem.create({
      data: { restaurantId: v.restaurantId!, section: m.section.trim(), name: m.name.trim(), description: m.description?.trim() ?? '', price: money(m.price, 'price', 'price'), veg: !!m.veg, photo: m.photo ?? null, available: true },
    });
    return this.menu(userId);
  }

  async editItem(userId: string, id: string, m: { price?: number; available?: boolean }) {
    const v = await this.kitchen(userId);
    const item = await this.prisma.menuItem.findFirst({ where: { id, restaurantId: v.restaurantId! } });
    if (!item) throw notFound('Dish');
    await this.prisma.menuItem.update({ where: { id }, data: { ...(m.price !== undefined ? { price: money(m.price, 'price', 'price') } : {}), ...(m.available !== undefined ? { available: m.available } : {}) } });
    return this.menu(userId);
  }

  /** Prep timer shown to customers as the ETA, and the price-for-two badge. */
  async kitchenSettings(userId: string, s: { etaMin?: number; costForTwo?: number }) {
    const v = await this.kitchen(userId);
    const data: { etaMin?: number; costForTwo?: number } = {};
    if (s.etaMin !== undefined) {
      if (!Number.isInteger(s.etaMin) || s.etaMin < 10 || s.etaMin > 120) throw invalid('ETA', 'Prep time must be between 10 and 120 minutes', 'etaMin');
      data.etaMin = s.etaMin;
    }
    if (s.costForTwo !== undefined) data.costForTwo = money(s.costForTwo, 'costForTwo', 'cost for two');
    await this.prisma.restaurant.update({ where: { id: v.restaurantId! }, data });
    return this.menu(userId);
  }

  /* ---------------- agent: property listings ---------------- */

  private async agent(userId: string) {
    const v = await this.partner.vendor(userId);
    if (v.category !== 'agent') throw invalid('CATEGORY', 'Only agents have listings');
    return v;
  }

  async listings(userId: string) {
    const v = await this.agent(userId);
    const list = await this.prisma.property.findMany({ where: { agentId: v.id }, include: { _count: { select: { enquiries: true, shortlists: true } } }, orderBy: { listedAt: 'desc' } });
    return list.map(({ _count, ...p }) => ({ ...p, enquiries: _count.enquiries, shortlists: _count.shortlists }));
  }

  async addListing(userId: string, l: { title: string; type: string; bhk?: number; areaSqft: number; price: number; locality: string; description: string; amenities?: string[]; photos?: string[] }) {
    const v = await this.agent(userId);
    if (!l.title || l.title.trim().length < 5) throw invalid('TITLE', 'Give the listing a short title', 'title');
    if (!['apartment', 'villa', 'plot'].includes(l.type)) throw invalid('TYPE', 'Choose apartment, villa or plot', 'type');
    if (l.type !== 'plot' && (!Number.isInteger(l.bhk) || l.bhk! < 1 || l.bhk! > 10)) throw invalid('BHK', 'Choose the number of bedrooms', 'bhk');
    if (!Number.isInteger(l.areaSqft) || l.areaSqft < 100) throw invalid('AREA', 'Enter the area in square feet', 'areaSqft');
    if (!l.locality?.trim()) throw invalid('LOCALITY', 'Enter the locality', 'locality');
    if (!l.description || l.description.trim().length < 20) throw invalid('DESCRIPTION', 'Describe the property in a couple of sentences', 'description');
    (l.photos ?? []).forEach((p) => checkPhoto(p, 'photos'));
    await this.prisma.property.create({
      data: {
        id: `prop-${code(6).toLowerCase()}`,
        title: l.title.trim(),
        type: l.type,
        bhk: l.type === 'plot' ? null : l.bhk!,
        areaSqft: l.areaSqft,
        price: money(l.price, 'price', 'price'),
        locality: l.locality.trim(),
        city: v.district,
        photos: l.photos?.length ? l.photos.slice(0, 6) : ['https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=900&q=70'],
        amenities: (l.amenities ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 12),
        description: l.description.trim(),
        agentName: v.businessName ?? v.name,
        agentRating: v.rating,
        agentId: v.id,
        verified: v.status === 'approved',
        status: 'active',
      },
    });
    return this.listings(userId);
  }

  async editListing(userId: string, id: string, l: { price?: number; status?: string }) {
    const v = await this.agent(userId);
    const p = await this.prisma.property.findFirst({ where: { id, agentId: v.id } });
    if (!p) throw notFound('Listing');
    if (l.status && !['active', 'paused', 'sold'].includes(l.status)) throw invalid('STATUS', 'Choose active, paused or sold', 'status');
    await this.prisma.property.update({ where: { id }, data: { ...(l.price !== undefined ? { price: money(l.price, 'price', 'price') } : {}), ...(l.status ? { status: l.status } : {}) } });
    return this.listings(userId);
  }
}
