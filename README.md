# myscan

Bản **Android native, offline** nằm trong `android/`: chụp, chỉnh ảnh, sắp xếp và xuất PDF hoàn toàn trên điện thoại, từ Android **8.0 trở lên**.

**[Tải APK Android 1.0.0 thử nghiệm](https://github.com/nhhai-math/myscan/raw/refs/heads/main/downloads/myscan-android-1.0.0-debug.apk)** · [Hướng dẫn cài qua QR](docs/android-download.md) · [Mã nguồn và cách build](android/README.md)

Quét mã QR bằng camera điện thoại để tải APK:

[![QR tải myscan Android](docs/myscan-android-download-qr.png)](https://github.com/nhhai-math/myscan/raw/refs/heads/main/downloads/myscan-android-1.0.0-debug.apk)

APK được ký bằng khóa debug để cài thử; chưa phát hành trên Google Play. Mã QR cần Internet để tải bộ cài; sau khi cài, ứng dụng quét và xuất PDF offline.

## Bản web qua QR

Ứng dụng web để **quét trên điện thoại → chỉnh ảnh trên máy tính → ghép tài liệu PDF**. Giao diện tiếng Việt, một máy chủ phục vụ cả hai thiết bị.

Thiết kế tham khảo luồng quét LAN trong đoạn mã MyTeX được cung cấp: phiên kết nối QR, trạng thái điện thoại, lưu riêng ảnh gốc và bản chỉnh, mở lại tài liệu cục bộ. Chức năng hiện có tập trung vào quét tài liệu.

## Chạy ứng dụng

Cần Node.js **22.12 trở lên**; môi trường này đã kiểm tra với **24.19.0**. Không cần cơ sở dữ liệu hoặc dịch vụ bên ngoài.

```bash
npm ci
npm run dev
```

Mở trình duyệt trên máy tính tại `http://localhost:3000`. Lần đầu, đặt mật khẩu quản lý thư viện. Điện thoại kết nối qua QR không cần mật khẩu này.

Để chạy bản production:

```bash
npm run build
npm start
```

Máy chủ mặc định lắng nghe cổng **3000** trên mọi giao diện mạng. Hãy thiết lập mật khẩu trên máy tính trước khi chia sẻ địa chỉ máy chủ.

## Quét và hoàn thiện

1. **Tạo tài liệu** và đặt tên.
2. Chọn **Kết nối điện thoại**, chọn địa chỉ LAN của máy tính, rồi quét mã QR. Hai thiết bị cần dùng cùng Wi-Fi/LAN. Cho phép Node.js/cổng 3000 qua tường lửa **mạng riêng** nếu cần.
3. Trên điện thoại, chụp bằng camera hoặc chọn ảnh có sẵn, xem lại rồi bấm **Gửi lên máy tính**. Ảnh xuất hiện trong tài liệu trên máy tính mà không cần tải lại trang.
4. Chọn **Chỉnh sửa**: kéo bốn điểm tới mép giấy để cắt và chỉnh phối cảnh; xoay ảnh; chọn màu gốc, thang xám hoặc đen trắng; chỉnh sáng và tương phản. Bấm **Lưu bản scan**. Các thiết lập được giữ khi mở lại trình chỉnh sửa; **Khôi phục ảnh gốc** đặt lại toàn bộ.
5. Kéo các trang hoặc dùng mũi tên lên/xuống để sắp xếp. **Xuất PDF** ghép toàn bộ trang theo thứ tự hiện tại, với khổ A4 hoặc theo tỷ lệ ảnh.

Có thể thêm ảnh trực tiếp trên máy tính bằng nút chọn ảnh hoặc kéo/thả. Giao diện nhận tối đa 20 ảnh mỗi lần. Máy chủ giới hạn 20 MB/ảnh, 48 triệu điểm ảnh đầu vào và 200 trang/tài liệu. JPEG, PNG và WebP được hỗ trợ; nếu ảnh HEIC không đọc được, chuyển sang JPEG hoặc chọn chế độ camera “Tương thích nhất”.

### Camera và địa chỉ kết nối

- Camera trực tiếp trong trình duyệt cần **HTTPS** hoặc localhost. Khi dùng HTTP qua LAN, nút chụp mở camera gốc của điện thoại; vẫn có thể gửi ảnh bình thường, không cần cài chứng chỉ.
- Địa chỉ localhost trên máy tính không dùng để kết nối từ điện thoại. Trong hộp QR, chọn IP LAN hoặc nhập địa chỉ máy chủ mà điện thoại truy cập được.
- Nếu chạy trên cloud, cần một địa chỉ **HTTPS** do hệ thống triển khai cung cấp. Có thể đặt `PUBLIC_URL` hoặc nhập địa chỉ đó trong hộp kết nối. Ứng dụng không tự tạo đường hầm hoặc công bố máy chủ ra Internet.
- Phiên QR có hiệu lực **2 giờ**, chỉ cho phép xem tên/số trang và gửi ảnh vào tài liệu đã chọn. Bấm **Dừng kết nối** để thu hồi phiên hiện tại. Thu nhỏ hộp QR giữ phiên hoạt động để tiếp tục nhận ảnh.

## Lưu trữ và cấu hình

Theo mặc định, dữ liệu nằm trong **`.data/`**, được bỏ qua bởi Git:

- `metadata.json`: tài liệu, thứ tự trang, thiết lập chỉnh ảnh và phiên kết nối.
- `documents/`: ảnh nguồn đã chuẩn hóa hướng và chuyển sang JPEG, cùng bản ảnh đã chỉnh. Các lần chỉnh sửa luôn dựng lại từ ảnh nguồn, tránh giảm chất lượng do chỉnh lặp.
- `owner.json`: mật khẩu đã băm bằng scrypt và salt; không chứa mật khẩu rõ.

Sao lưu **toàn bộ thư mục dữ liệu** khi máy chủ dừng. Không chạy hai tiến trình myscan cùng ghi vào một thư mục dữ liệu. Phiên đăng nhập tồn tại tối đa 12 giờ và cần đăng nhập lại sau khi máy chủ khởi động lại.

| Biến | Mặc định | Mục đích |
| --- | --- | --- |
| `PORT` | `3000` | Cổng HTTP |
| `HOST` | `0.0.0.0` | Giao diện mạng lắng nghe |
| `DATA_DIR` | `.data` trong thư mục chạy lệnh | Thư mục lưu dữ liệu |
| `PUBLIC_URL` | Không đặt | Địa chỉ công khai HTTP/HTTPS của máy chủ |

Ví dụ PowerShell trên Windows:

```powershell
cd D:\Apps\myscan
npm ci
$env:PORT = "3000"
npm run dev
```

Nếu quên mật khẩu, dừng máy chủ, sao lưu dữ liệu rồi **đổi tên riêng tệp `owner.json`**. Khởi động lại và đặt mật khẩu mới; tài liệu vẫn được giữ. Không xóa toàn bộ `.data` để đặt lại mật khẩu.

## Kiểm tra

```bash
npm test
npm run build
npm run test:e2e
```

- Kiểm thử API: đăng nhập, phân quyền điện thoại, tải ảnh, hướng EXIF, giữ ảnh gốc, thứ tự PDF, dữ liệu sau khởi động lại, ảnh hỏng/quá lớn, phiên hết hạn/thu hồi và cập nhật trực tiếp.
- Kiểm thử hình học: bốn góc hợp lệ, homography, phép chiếu và hình suy biến.
- Playwright: luồng quản lý + một trình duyệt điện thoại riêng, chỉnh ảnh, tải PDF và các phép xử lý Canvas. Dữ liệu kiểm thử được tạo riêng trong thư mục tạm.

Kiểm thử trình duyệt dùng Chromium tại `/usr/bin/chromium` nếu có. Trên máy khác, chạy `npx playwright install chromium` trước hoặc đặt `PLAYWRIGHT_CHROMIUM_PATH` tới tệp thực thi Chromium.

## Cấu trúc

`src/` chứa React/TypeScript và xử lý ảnh Canvas; `server/` chứa Express, xử lý ảnh Sharp, xuất PDF bằng pdf-lib và lưu JSON nguyên tử. Máy tính nhận cập nhật qua Server-Sent Events. Mật khẩu bảo vệ API quản lý; token QR chỉ có quyền gửi ảnh vào phiên đã ghép.
