export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ALLOWED_ORIGINS: string;
  FACILITY_NAME: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
}

export type RequestType = 'SCHEDULED_MOVE_OUT' | 'COMPLETED_MOVE_OUT';
export type RequestStatus = 'NEW' | 'REVIEWED' | 'COMPLETED';
export type PhotoSlot = 'INSIDE' | 'FLOOR' | 'DOOR' | 'EXTRA';

export const REQUIRED_SLOTS: PhotoSlot[] = ['INSIDE', 'FLOOR', 'DOOR'];
export const MAX_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface MoveOutRow {
  id: string;
  type: RequestType;
  status: RequestStatus;
  facility: string;
  phone: string;
  phone_display: string;
  customer_name: string | null;
  planned_move_out_date: string | null;
  unit_number: string | null;
  completed_at: string | null;
  confirmed_empty: number | null;
  confirmed_swept: number | null;
  confirmed_lock_removed: number | null;
  idempotency_key: string;
  submitted_at: string;
  created_at: string;
  updated_at: string;
  staff_note: string | null;
  user_agent: string | null;
}

export interface PhotoRow {
  id: string;
  request_id: string | null;
  slot: PhotoSlot;
  r2_key: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  upload_token: string;
  created_at: string;
}
