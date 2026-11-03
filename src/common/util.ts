import { randomInt } from 'node:crypto';

/** ₹ → paise and back. All money in the database is integer paise. */
export const paise = (rupees: number) => Math.round(rupees * 100);
export const rupees = (p: number) => p / 100;

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const code = (len: number) => Array.from({ length: len }, () => ALPHA[randomInt(ALPHA.length)]).join('');
export const digits = (len: number) => Array.from({ length: len }, () => randomInt(10)).join('');

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400000);
export const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
