# Tín hiệu Crypto 2–3 ngày

Website lấy 20 đồng crypto vốn hóa lớn nhất (đã loại stablecoin, token bọc/staking, token vàng/RWA), phân tích nến 4H và đưa ra tín hiệu **LONG / SHORT / Đứng ngoài** kèm Entry, Stop loss, TP1, TP2 cho lệnh giữ 2–3 ngày, cùng backtest của chính quy tắc đó trên ~5 tháng dữ liệu.

> ⚠️ Công cụ phân tích kỹ thuật tự động, **không phải lời khuyên đầu tư**.

## Cấu trúc

```
index.html, styles.css, app.js     Giao diện (HTML/JS thuần, không cần build)
config.js                          Điền Supabase URL + anon key (tùy chọn)
supabase/functions/_shared/
  engine.js                        Chỉ báo, chấm điểm, kế hoạch lệnh, backtest
  market.js                        Lấy dữ liệu CoinGecko, Binance/Bybit/OKX, funding, Fear & Greed
supabase/functions/update-signals/ Edge Function chạy mỗi giờ, lưu tín hiệu + nhật ký lệnh
supabase/migrations/               Bảng signal_runs, signal_snapshots, signal_trades
supabase/cron.sql                  Lịch chạy pg_cron (chạy 1 lần thủ công)
```

Trình duyệt và Edge Function dùng **chung** `engine.js` + `market.js`, nên tín hiệu ở hai nơi giống hệt nhau.

## Chạy ngay (không cần back-end)

```bash
python -m http.server 8080
```

Mở http://localhost:8080. Trang tự tính tín hiệu trong trình duyệt (~3 giây) và tự làm mới mỗi 15 phút.
Muốn đưa lên mạng: tải cả thư mục lên bất kỳ host tĩnh nào (Netlify, Vercel, Cloudflare Pages, GitHub Pages).

## Bật back-end Supabase (tùy chọn)

Back-end giúp: tín hiệu được tính mỗi giờ kể cả khi bạn không mở web, và có tab **Nhật ký tín hiệu** ghi lại từng lệnh thật sự phát ra cùng kết quả (SL/TP1/TP2/hết 72h). Đây là cách kiểm chứng trung thực nhất, tốt hơn backtest.

1. Tạo project tại https://supabase.com (Region nên chọn **Singapore**).
2. **SQL Editor** → dán và chạy `supabase/migrations/20261115000000_init.sql`.
3. Deploy Edge Function — chọn **một** trong hai cách:

   **Cách A — trên Dashboard, không cần cài gì:**
   `python tools/bundle_edge_function.py` tạo file `dist/update-signals.ts`. Vào **Edge Functions → Deploy a new function → Via Editor**, đặt tên `update-signals`, xóa code mẫu, dán toàn bộ nội dung file đó, bấm **Deploy**. Sau đó vào trang chi tiết của function → tắt **Verify JWT / Enforce JWT verification**. Cuối cùng vào **Edge Functions → Secrets** thêm `CRON_SECRET` = một chuỗi bí mật dài.
   Mỗi lần sửa `engine.js`/`market.js` thì chạy lại script và dán lại.

   **Cách B — dùng Supabase CLI** (cần cài Node.js):
   ```bash
   npx supabase login
   ```
   ```bash
   npx supabase link --project-ref YOUR-PROJECT-REF
   ```
   ```bash
   npx supabase secrets set CRON_SECRET=mot-chuoi-bi-mat-dai
   ```
   ```bash
   npx supabase functions deploy update-signals
   ```
4. Chạy thử một lần (trên Windows dùng `curl.exe`):
   ```bash
   curl.exe -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/update-signals -H "x-cron-secret: mot-chuoi-bi-mat-dai"
   ```
5. Mở `supabase/cron.sql`, thay `YOUR-PROJECT-REF` và `YOUR-CRON-SECRET`, chạy trong SQL Editor để lên lịch mỗi giờ.
6. Điền `SUPABASE_URL` và `SUPABASE_ANON_KEY` (Project Settings → API) vào `config.js`.
7. Đưa website lên mạng: kéo-thả cả thư mục dự án vào https://app.netlify.com/drop (hoặc Vercel / Cloudflare Pages). Anon key nằm công khai trong `config.js` là bình thường — bảng chỉ cho đọc.

Bảng chỉ cho phép **đọc** bằng anon key; chỉ Edge Function (service role) được ghi.

## Phương pháp

Điểm −100…+100 = tổng có trọng số: xu hướng khung ngày (EMA120/EMA300 trên 4H) 25, xu hướng 4H (EMA21/55) 20, MACD 15, RSI 15, ADX/DMI 10, sức mạnh so với BTC 10, khối lượng 5, funding 5.
≥ +40 → LONG, ≤ −40 → SHORT. Chi tiết xem tab “Cách hoạt động” trên web.

Kế hoạch lệnh: SL = 3×ATR(4H) (=1R) · TP1 = 0,8×ATR, chốt 50% rồi dời SL về hòa vốn · TP2 = 3×ATR (1R) · đóng sau 72h.

## Về tỷ lệ thắng ≥ 70%

Cấu hình SL/TP trên được chọn để tỷ lệ lệnh có lãi trong backtest đạt ~73% (595 lệnh, 20 coin, 21/07 → 15/11/2026). Kết quả khi so sánh:

| Cấu hình | Tỷ lệ có lãi | R trung bình / lệnh |
|---|---|---|
| SL 2 ATR, TP 1R → 2R | ~49% | −0,03R |
| **SL 3 ATR, TP1 0,8 ATR, TP2 3 ATR (đang dùng)** | **~73%** | **−0,01R** |

Win rate tăng là do TP gần + SL xa: thắng nhỏ, thua đủ 1R. **Lợi nhuận kỳ vọng gần như không đổi và quanh mức 0.** Trong giai đoạn kiểm thử, lệnh SHORT tốt hơn LONG một chút (thị trường đang giảm). Hãy theo dõi cột R TB và tab Nhật ký trước khi dùng tiền thật.

Muốn đổi tham số: sửa `CONFIG` ở đầu `supabase/functions/_shared/engine.js` (sau đó deploy lại Edge Function nếu dùng Supabase).
