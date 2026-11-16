// Để trống = website tự tính tín hiệu ngay trong trình duyệt (không cần back-end).
// Điền URL + anon key của Supabase = đọc tín hiệu do Edge Function tính sẵn mỗi giờ
// và bật tab "Nhật ký tín hiệu" (theo dõi kết quả thực tế của từng lệnh).
window.APP_CONFIG = {
  SUPABASE_URL: '', // ví dụ: 'https://abcdxyz.supabase.co'
  SUPABASE_ANON_KEY: '', // Project Settings → API → anon public key
};
