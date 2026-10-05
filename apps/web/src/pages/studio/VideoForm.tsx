import { useState, type ReactNode } from 'react';
import { MAX_VIDEO_PRICE_STRM, MAX_TAGS, MAX_VIDEO_TITLE, parseSTRM, weiToString } from '@tesor_gp/shared';
import { Field } from '../../components/Field';
import { getMoneyFormat, isBankMode, moneyUnit } from '../../lib/format';
import { formatSTRM } from '@tesor_gp/shared';

export interface VideoFormValues {
  title: string;
  description: string;
  category: string;
  tags: string;
  /** Price of the whole video, as typed. */
  price: string;
}

export function validateVideoForm(v: VideoFormValues, maxPrice = MAX_VIDEO_PRICE_STRM): { errors: Record<string, string>; priceWei?: string; tags?: string[] } {
  const errors: Record<string, string> = {};
  if (!v.title.trim()) errors.title = 'Give your video a title';
  else if (v.title.trim().length > MAX_VIDEO_TITLE) errors.title = `Title must be ${MAX_VIDEO_TITLE} characters or fewer`;
  let priceWei: string | undefined;
  const price = v.price.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(price)) errors.price = 'Enter a price like 20 (or 0 for free)';
  else {
    const wei = parseSTRM(price);
    if (wei > parseSTRM(String(maxPrice))) errors.price = isBankMode() ? `Price can be at most ${getMoneyFormat().symbol}${maxPrice}` : `Price can be at most ${maxPrice} STRM`;
    else priceWei = weiToString(wei);
  }
  const tags = v.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length > MAX_TAGS) errors.tags = `Use at most ${MAX_TAGS} tags`;
  const out: { errors: Record<string, string>; priceWei?: string; tags?: string[] } = { errors, tags };
  if (priceWei !== undefined) out.priceWei = priceWei;
  return out;
}

export function weiToPriceInput(wei: string): string {
  return formatSTRM(BigInt(wei || '0'), 18);
}

export function VideoFields({ values, onChange, errors, categories, children }: { values: VideoFormValues; onChange(v: VideoFormValues): void; errors: Record<string, string>; categories: string[]; children?: ReactNode }): JSX.Element {
  const [touched] = useState(false);
  void touched;
  const set = (k: keyof VideoFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => onChange({ ...values, [k]: e.target.value });
  return (
    <>
      <Field label="Title" value={values.title} onChange={set('title')} error={errors.title} maxLength={MAX_VIDEO_TITLE} />
      <div className="field">
        <label htmlFor="vf-desc">Description</label>
        <textarea id="vf-desc" rows={4} value={values.description} onChange={set('description')} maxLength={5000} />
      </div>
      <div className="field">
        <label htmlFor="vf-cat">Category</label>
        <select id="vf-cat" value={values.category} onChange={set('category')}>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <Field label="Tags" value={values.tags} onChange={set('tags')} error={errors.tags} hint="Comma separated, up to 10" />
      <Field label={`Price (${moneyUnit()})`} inputMode="decimal" value={values.price} onChange={set('price')} error={errors.price} hint={`One price for the whole video; 0 makes it free. Maximum ${MAX_VIDEO_PRICE_STRM}. Viewers get time-limited access after paying.`} />
      {children}
    </>
  );
}
