# Guardian — Runbook vận hành (Phase 2.5)

Tài liệu xử lý sự cố thường gặp. Nguyên tắc chung: đọc trạng thái thật (ledger / PayPal API) trước khi kết luận; không chạy lại lệnh ghi khi chưa biết kết quả lần đầu.

## 1. Agent trả lỗi 401/403 từ PayPal
- **401 lặp lại:** access token hết hạn (~9h) — SDK tự refresh bằng client credentials. Nếu vẫn 401: kiểm tra `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` trên env của môi trường đang chạy (Vercel: Project → Settings → Environment Variables) có khớp app GuardianAI (sandbox) không.
- **403 NOT_AUTHORIZED khi tạo invoice:** app thiếu scope Invoicing. Vào Developer Dashboard → Apps & Credentials → GuardianAI → tick **Invoicing** (+ **Transaction Search** cho báo cáo tiền) → **Save changes** → chờ ~3–10 phút rồi thử lại. Đổi feature mà không bấm Save = không có tác dụng.
- **Thiếu số liệu tiền trong báo cáo:** token thiếu scope transactions → Analyst phải khai báo thiếu. Xử lý như trên (tick Transaction Search).

## 2. Webhook không về / dispute mới không được báo
1. Kiểm tra env `PAYPAL_WEBHOOK_ID` đã set trên Vercel chưa (thiếu = chế độ unverified-dev, sự kiện vẫn vào nhưng bị gắn nhãn).
2. Developer Dashboard → Webhooks: webhook `6307410219297204N` phải trỏ đúng `https://guardian-ai-ruby.vercel.app/api/webhooks/paypal` và có event CUSTOMER.DISPUTE.*.
3. Dashboard → Testing tools → Event logs: xem PayPal có bắn không, bắn thì trả mã gì. Endpoint của ta trả 401 khi chữ ký sai — nếu PayPal bắn thật mà vẫn 401, khả năng webhook id trên env lệch với webhook đã đăng ký → đăng ký lại bằng `scripts/register-webhook.mjs` và cập nhật env, redeploy.
4. Sự kiện trùng là bình thường — hệ đã chống trùng bằng event_id, đừng "xử lý tay".

## 3. Job (radar / reconcile) trả 503 hoặc 401
- **503:** thiếu env `GUARDIAN_JOB_SECRET` trên môi trường đó — job route chủ động từ chối khi không có secret. Set env rồi redeploy.
- **401:** header `x-job-secret` sai. Secret nằm ở `.env.local` (local) và Vercel env (production) — 2 nơi phải khớp nhau nếu muốn chạy job production từ máy local.

## 4. Lệnh ghi bị đánh dấu RECONCILE_NEEDED
- Nghĩa: lệnh đã gửi nhưng chưa xác nhận được trạng thái cuối. **Không bấm chạy lại.**
- Chạy reconcile sweep (`POST /api/jobs/reconcile` kèm secret, hoặc `node scripts/run-reconcile.mjs` ở local) — nó đọc lại trạng thái thật và đóng cờ nếu khớp.
- Lệch > 24h: hệ tự tạo alert instant. Lúc đó kiểm tra tay trên PayPal Dashboard bằng id trong ledger rồi mới quyết định bước tiếp theo.

## 5. Approval kẹt / hết hạn
- Approval hết hạn sau 24h (trạng thái EXPIRED) — không quyết được nữa; hỏi lại Guardian để nó tạo approval mới với tham số cập nhật.
- Approval đã APPROVED mà chưa EXECUTED: kiểm tra ledger dòng execute tương ứng — có thể executor đang chờ read-back; chạy reconcile sweep trước khi can thiệp.

## 6. Mất LLM key / não AI không khả dụng
- Hệ tự rơi về **demo mode** và gắn nhãn rõ ràng — không im lặng giả vờ chạy live.
- Watchers rule-based (radar deadline, reconcile) vẫn chạy bình thường không cần LLM.
- Khôi phục: bổ sung key (env `AI_API_KEY` + `AI_PROVIDER`) rồi redeploy; kiểm tra bằng 1 câu chat và đối chiếu Activity log.

## 7. Dữ liệu production "trống" (casesChecked: 0)
- Triệu chứng đã biết của giai đoạn SQLite-on-Vercel: DB ở `/tmp` theo từng instance, instance mới = store trống. Cơ chế vẫn đúng; dữ kiện bền xuyên instance chỉ có sau khi chuyển Postgres (Phase 2).
- Kiểm tra phân biệt: nếu cả ở local (DB file `data/guardian.db`) cũng trống → seed chưa chạy: seed idempotent, chạy `seedGuardianMemory` 1 lần là đủ.

## 8. PayPal 429 / rate limit
- Dừng hẳn nhóm tool đó trong lượt, ghi chú vào digest. Không lách đường khác, không tăng tốc độ gọi. Reminder invoice bị giới hạn sẵn 2 lần/ngày/invoice — Collections phải tôn trọng.
