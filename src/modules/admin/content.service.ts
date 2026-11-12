import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { invalid, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { AdminService } from './admin.service';
import { SettingsService, type Slide } from './settings.service';

/** A picture or video: an https link, or a file uploaded to the media library. */
export const isMedia = (v: unknown) => typeof v === 'string' && (v === '' || /^https:\/\/\S+$/.test(v) || /^\/media\/[a-f0-9]{24}$/.test(v));
const need = (v: unknown, field: string, label: string) => {
  if (typeof v !== 'string' || !v.trim()) throw invalid('REQUIRED', `${label} is required`, field);
  return v.trim();
};
const media = (v: unknown, field: string, required = true) => {
  if (!isMedia(v) || (required && !v)) throw invalid('MEDIA', 'Pick an image from the media library or paste an https link', field);
  return v as string;
};
const paise = (v: unknown, field: string, label: string, min = 0) => {
  if (!Number.isInteger(v) || (v as number) < min) throw invalid('PRICE', `Enter a valid ${label}`, field);
  return v as number;
};
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

type ServiceIn = { code?: string; label?: string; photo?: string; issues?: string[]; visitCharge?: number; requiresQuote?: boolean; live?: boolean; sort?: number };
type ProductIn = { title?: string; brand?: string | null; description?: string; categoryId?: string; sellerId?: string; price?: number; mrp?: number; stock?: number; photos?: string[]; trending?: boolean; active?: boolean };

/** Admin CMS: everything a customer sees can be added, changed or removed here. */
@Injectable()
export class ContentService {
  constructor(
    private prisma: PrismaService,
    private admin: AdminService,
    private settings: SettingsService,
  ) {}

  /* ---------------- home screen content ---------------- */

  /** Checks the Home content before it is saved, so the app never receives a broken screen. */
  validateAppContent(v: unknown) {
    const c = v as Awaited<ReturnType<SettingsService['get']>> & Record<string, unknown>;
    const content = c as unknown as { hero: Record<string, string>; slides: Slide[]; emergency: { key: string; title: string; subtitle: string; image: string }[]; cab: { title: string; subtitle: string }; searchPlaceholder: string };
    if (!content?.hero || !Array.isArray(content.slides) || !Array.isArray(content.emergency)) throw invalid('CONTENT', 'Home content is incomplete');
    need(content.hero.line1, 'hero', 'Headline');
    if (content.slides.length > 10) throw invalid('SLIDES', 'Use at most 10 slides', 'slides');
    content.slides.forEach((s, i) => {
      if (!['image', 'video'].includes(s.type)) throw invalid('SLIDE', `Slide ${i + 1}: choose image or video`, 'slides');
      media(s.media, 'slides');
      media(s.poster ?? '', 'slides', false);
      if (!['none', 'shop', 'service', 'category', 'product', 'url'].includes(s.action?.kind)) throw invalid('SLIDE', `Slide ${i + 1}: choose where it opens`, 'slides');
      if (s.action.kind === 'url' && !/^https:\/\//.test(s.action.target)) throw invalid('SLIDE', `Slide ${i + 1}: the link must start with https://`, 'slides');
      if (['service', 'category', 'product'].includes(s.action.kind) && !s.action.target) throw invalid('SLIDE', `Slide ${i + 1}: pick what it opens`, 'slides');
    });
    content.emergency.forEach((e) => {
      need(e.title, 'emergency', 'Emergency card title');
      media(e.image, 'emergency');
    });
    need(content.cab?.title, 'cab', 'Cab card title');
  }

  validateBranding(v: unknown) {
    const b = v as { appName: string; logo: string };
    need(b?.appName, 'appName', 'App name');
    media(b.logo, 'logo', false);
  }

  /* ---------------- services ---------------- */

  async createService(adminId: string, s: ServiceIn) {
    const label = need(s.label, 'label', 'Service name');
    const code = slug(s.code || label);
    if (!code) throw invalid('CODE', 'Give the service a name', 'label');
    if (await this.prisma.service.findUnique({ where: { code } })) throw invalid('CODE', 'A service with this name already exists', 'label');
    const issues = (s.issues ?? []).map((x) => x.trim()).filter(Boolean);
    if (!issues.length) throw invalid('ISSUES', 'Add at least one option customers can pick, like “Repair”', 'issues');
    const max = await this.prisma.service.aggregate({ _max: { sort: true } });
    // new services run on the booking engine (pros accept, quote, invoice), so they join the home group
    await this.prisma.service.create({
      data: { code, label, photo: media(s.photo, 'photo'), group: 'home', issues, visitCharge: paise(s.visitCharge ?? 0, 'visitCharge', 'visit charge'), requiresQuote: !!s.requiresQuote, live: s.live ?? true, sort: (max._max.sort ?? 0) + 1 },
    });
    await this.admin.audit(adminId, 'service.create', `service:${code}`, { label });
    return code;
  }

  async updateService(adminId: string, code: string, s: ServiceIn) {
    const svc = await this.prisma.service.findUnique({ where: { code } });
    if (!svc) throw notFound('Service');
    const data: Record<string, unknown> = {};
    if (s.label !== undefined) data.label = need(s.label, 'label', 'Service name');
    if (s.photo !== undefined) data.photo = media(s.photo, 'photo');
    if (s.issues !== undefined) {
      const issues = s.issues.map((x) => x.trim()).filter(Boolean);
      if (!issues.length && svc.group === 'home') throw invalid('ISSUES', 'Keep at least one option', 'issues');
      data.issues = issues;
    }
    if (s.visitCharge !== undefined) data.visitCharge = paise(s.visitCharge, 'visitCharge', 'visit charge');
    if (s.requiresQuote !== undefined) data.requiresQuote = s.requiresQuote;
    if (s.live !== undefined) data.live = s.live;
    if (s.sort !== undefined) data.sort = s.sort;
    await this.prisma.service.update({ where: { code }, data });
    await this.admin.audit(adminId, 'service.save', `service:${code}`, s as never);
  }

  /** Moves a service up or down in the app's order. */
  async moveService(adminId: string, code: string, dir: 'up' | 'down') {
    const all = await this.prisma.service.findMany({ orderBy: { sort: 'asc' } });
    const i = all.findIndex((x) => x.code === code);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    await Promise.all(all.map((x, k) => (x.sort === k ? null : this.prisma.service.update({ where: { code: x.code }, data: { sort: k } }))));
    await this.admin.audit(adminId, 'service.move', `service:${code}`, { dir });
  }

  async deleteService(adminId: string, code: string) {
    const svc = await this.prisma.service.findUnique({ where: { code } });
    if (!svc) throw notFound('Service');
    if (svc.group !== 'home') throw invalid('CORE', 'Cabs, food, property and SOS are built-in. Turn them off instead of deleting.');
    if (await this.prisma.booking.count({ where: { serviceCode: code } })) throw invalid('IN_USE', 'Customers have booked this service, so it cannot be deleted. Turn it off instead.');
    const vendors = await this.prisma.vendor.findMany({ where: { services: { has: code } }, select: { id: true, services: true } });
    await Promise.all(vendors.map((v) => this.prisma.vendor.update({ where: { id: v.id }, data: { services: v.services.filter((s) => s !== code) } })));
    await this.prisma.service.delete({ where: { code } });
    await this.admin.audit(adminId, 'service.delete', `service:${code}`, { label: svc.label });
  }

  /* ---------------- shop: categories, products, coupons ---------------- */

  async saveCategory(adminId: string, c: { id?: string; name: string; photo: string; sort?: number }) {
    const name = need(c.name, 'name', 'Category name');
    const photo = media(c.photo, 'photo');
    const id = c.id ?? slug(name);
    if (!c.id && (await this.prisma.category.findUnique({ where: { id } }))) throw invalid('NAME', 'A category with this name exists', 'name');
    await this.prisma.category.upsert({ where: { id }, create: { id, name, photo, sort: c.sort ?? 99 }, update: { name, photo, ...(c.sort !== undefined ? { sort: c.sort } : {}) } });
    await this.admin.audit(adminId, 'category.save', `category:${id}`, { name });
  }

  async deleteCategory(adminId: string, id: string) {
    const n = await this.prisma.product.count({ where: { categoryId: id } });
    if (n) throw invalid('IN_USE', `Move or delete its ${n} product(s) first`);
    await this.prisma.category.delete({ where: { id } }).catch(() => {
      throw notFound('Category');
    });
    await this.admin.audit(adminId, 'category.delete', `category:${id}`);
  }

  private async productData(p: ProductIn, existing?: { price: number; mrp: number }) {
    const data: Record<string, unknown> = {};
    if (p.title !== undefined) data.title = need(p.title, 'title', 'Product name');
    if (p.brand !== undefined) data.brand = p.brand?.trim() || null;
    if (p.description !== undefined) data.description = need(p.description, 'description', 'Description');
    if (p.categoryId !== undefined) {
      if (!(await this.prisma.category.findUnique({ where: { id: p.categoryId } }))) throw invalid('CATEGORY', 'Choose a category', 'categoryId');
      data.categoryId = p.categoryId;
    }
    if (p.sellerId !== undefined) {
      if (!(await this.prisma.seller.findUnique({ where: { id: p.sellerId } }))) throw invalid('SELLER', 'Choose a seller', 'sellerId');
      data.sellerId = p.sellerId;
    }
    const price = p.price !== undefined ? paise(p.price, 'price', 'price', 1) : existing?.price;
    const mrp = p.mrp !== undefined ? paise(p.mrp, 'mrp', 'MRP', 1) : existing?.mrp;
    if (price !== undefined && mrp !== undefined && mrp < price) throw invalid('MRP', 'MRP cannot be lower than the price', 'mrp');
    if (p.price !== undefined) data.price = price;
    if (p.mrp !== undefined) data.mrp = mrp;
    if (p.stock !== undefined) data.stock = paise(p.stock, 'stock', 'stock');
    if (p.photos !== undefined) {
      if (!p.photos.length) throw invalid('PHOTOS', 'Add at least one photo', 'photos');
      p.photos.forEach((x) => media(x, 'photos'));
      data.photos = p.photos.slice(0, 8);
    }
    if (p.trending !== undefined) data.trending = p.trending;
    if (p.active !== undefined) data.active = p.active;
    return data;
  }

  async createProduct(adminId: string, p: ProductIn) {
    for (const [k, l] of [['title', 'Product name'], ['description', 'Description'], ['categoryId', 'Category'], ['sellerId', 'Seller']] as const) need(p[k], k, l);
    if (p.price === undefined || p.mrp === undefined || !p.photos?.length) throw invalid('REQUIRED', 'Price, MRP and a photo are required');
    const data = await this.productData(p);
    const prod = await this.prisma.product.create({ data: { ...(data as object), rating: 0, reviews: 0, stock: (data.stock as number) ?? 0, active: p.active ?? true } as Prisma.ProductUncheckedCreateInput });
    await this.admin.audit(adminId, 'product.create', `product:${prod.id}`, { title: prod.title });
  }

  async updateProduct(adminId: string, id: string, p: ProductIn) {
    const prod = await this.prisma.product.findUnique({ where: { id } });
    if (!prod) throw notFound('Product');
    await this.prisma.product.update({ where: { id }, data: await this.productData(p, prod) });
    await this.admin.audit(adminId, 'product.save', `product:${id}`, p as never);
  }

  /** Orders keep their own copy of the items, so a product can be removed; carts drop it. */
  async deleteProduct(adminId: string, id: string) {
    const prod = await this.prisma.product.findUnique({ where: { id } });
    if (!prod) throw notFound('Product');
    await this.prisma.cartItem.deleteMany({ where: { productId: id } });
    await this.prisma.product.delete({ where: { id } });
    await this.admin.audit(adminId, 'product.delete', `product:${id}`, { title: prod.title });
  }

  sellers() {
    return this.prisma.seller.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  }

  async deleteCoupon(adminId: string, code: string) {
    await this.prisma.coupon.delete({ where: { code } }).catch(() => {
      throw notFound('Coupon');
    });
    await this.prisma.user.updateMany({ where: { coupon: code }, data: { coupon: null } });
    await this.admin.audit(adminId, 'coupon.delete', `coupon:${code}`);
  }

  /* ---------------- food: restaurants and menus ---------------- */

  restaurants() {
    return this.prisma.restaurant.findMany({ include: { menu: { orderBy: [{ section: 'asc' }, { name: 'asc' }] } }, orderBy: { sort: 'asc' } });
  }

  async saveRestaurant(adminId: string, id: string | null, r: { name?: string; kind?: string; cuisine?: string; photo?: string; locality?: string; etaMin?: number; costForTwo?: number; pureVeg?: boolean; open?: boolean; sort?: number }) {
    const data: Record<string, unknown> = {};
    if (r.name !== undefined) data.name = need(r.name, 'name', 'Name');
    if (r.kind !== undefined) {
      if (!['restaurant', 'kitchen'].includes(r.kind)) throw invalid('KIND', 'Choose restaurant or cloud kitchen', 'kind');
      data.kind = r.kind;
    }
    if (r.cuisine !== undefined) data.cuisine = need(r.cuisine, 'cuisine', 'Cuisine');
    if (r.photo !== undefined) data.photo = media(r.photo, 'photo');
    if (r.locality !== undefined) data.locality = need(r.locality, 'locality', 'Locality');
    if (r.etaMin !== undefined) data.etaMin = paise(r.etaMin, 'etaMin', 'delivery time', 5);
    if (r.costForTwo !== undefined) data.costForTwo = paise(r.costForTwo, 'costForTwo', 'cost for two');
    if (r.pureVeg !== undefined) data.pureVeg = r.pureVeg;
    if (r.open !== undefined) data.open = r.open;
    if (r.sort !== undefined) data.sort = r.sort;
    if (id) {
      await this.prisma.restaurant.update({ where: { id }, data }).catch(() => {
        throw notFound('Restaurant');
      });
    } else {
      for (const k of ['name', 'kind', 'cuisine', 'photo', 'locality'] as const) if (data[k] === undefined) throw invalid('REQUIRED', 'Name, type, cuisine, photo and locality are required', k);
      id = `rest-${slug(data.name as string)}-${Date.now().toString(36).slice(-4)}`;
      await this.prisma.restaurant.create({ data: { id, ...(data as object), rating: 4.5, ratings: 0, etaMin: (data.etaMin as number) ?? 30, costForTwo: (data.costForTwo as number) ?? 40000, sort: 99 } as Prisma.RestaurantUncheckedCreateInput });
    }
    await this.admin.audit(adminId, 'restaurant.save', `restaurant:${id}`, r as never);
  }

  async deleteRestaurant(adminId: string, id: string) {
    if (await this.prisma.foodOrder.count({ where: { restaurantId: id } })) throw invalid('IN_USE', 'This restaurant has orders. Close it instead of deleting.');
    if (await this.prisma.vendor.count({ where: { restaurantId: id } })) throw invalid('IN_USE', 'A partner runs this restaurant. Suspend the partner instead.');
    await this.prisma.menuItem.deleteMany({ where: { restaurantId: id } });
    await this.prisma.restaurant.delete({ where: { id } });
    await this.admin.audit(adminId, 'restaurant.delete', `restaurant:${id}`);
  }

  async saveMenuItem(adminId: string, restaurantId: string, id: string | null, m: { section?: string; name?: string; description?: string; price?: number; veg?: boolean; bestseller?: boolean; photo?: string | null; available?: boolean }) {
    const data: Record<string, unknown> = {};
    if (m.section !== undefined) data.section = need(m.section, 'section', 'Menu section');
    if (m.name !== undefined) data.name = need(m.name, 'name', 'Dish name');
    if (m.description !== undefined) data.description = m.description.trim();
    if (m.price !== undefined) data.price = paise(m.price, 'price', 'price', 1);
    if (m.veg !== undefined) data.veg = m.veg;
    if (m.bestseller !== undefined) data.bestseller = m.bestseller;
    if (m.photo !== undefined) data.photo = m.photo ? media(m.photo, 'photo') : null;
    if (m.available !== undefined) data.available = m.available;
    if (id) await this.prisma.menuItem.update({ where: { id }, data });
    else {
      if (!data.name || !data.section || data.price === undefined) throw invalid('REQUIRED', 'Name, section and price are required');
      await this.prisma.menuItem.create({ data: { restaurantId, description: '', veg: true, ...(data as object) } as Prisma.MenuItemUncheckedCreateInput });
    }
    await this.admin.audit(adminId, 'menu.save', `restaurant:${restaurantId}`, m as never);
  }

  async deleteMenuItem(adminId: string, id: string) {
    const m = await this.prisma.menuItem.delete({ where: { id } }).catch(() => {
      throw notFound('Dish');
    });
    await this.admin.audit(adminId, 'menu.delete', `restaurant:${m.restaurantId}`, { name: m.name });
  }

  /* ---------------- property listings ---------------- */

  async saveListing(adminId: string, id: string, l: { title?: string; price?: number; description?: string; photos?: string[]; amenities?: string[]; locality?: string }) {
    const data: Record<string, unknown> = {};
    if (l.title !== undefined) data.title = need(l.title, 'title', 'Title');
    if (l.price !== undefined) data.price = paise(l.price, 'price', 'price', 1);
    if (l.description !== undefined) data.description = need(l.description, 'description', 'Description');
    if (l.locality !== undefined) data.locality = need(l.locality, 'locality', 'Locality');
    if (l.photos !== undefined) {
      if (!l.photos.length) throw invalid('PHOTOS', 'Keep at least one photo', 'photos');
      l.photos.forEach((x) => media(x, 'photos'));
      data.photos = l.photos.slice(0, 10);
    }
    if (l.amenities !== undefined) data.amenities = l.amenities.map((a) => a.trim()).filter(Boolean);
    await this.prisma.property.update({ where: { id }, data }).catch(() => {
      throw notFound('Listing');
    });
    await this.admin.audit(adminId, 'listing.edit', `property:${id}`, l as never);
  }

  async deleteListing(adminId: string, id: string) {
    await this.prisma.enquiry.deleteMany({ where: { propertyId: id } });
    await this.prisma.shortlist.deleteMany({ where: { propertyId: id } });
    await this.prisma.property.delete({ where: { id } }).catch(() => {
      throw notFound('Listing');
    });
    await this.admin.audit(adminId, 'listing.delete', `property:${id}`);
  }
}
