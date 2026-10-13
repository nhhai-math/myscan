# myscan trên iPhone

myscan cho iPhone là ứng dụng web có thể thêm vào màn hình chính, hỗ trợ **iOS 16.4 trở lên**. Bạn chỉ cần iPhone và Safari để chụp tài liệu, chỉnh ảnh, sắp xếp trang và xuất PDF. Sau lần mở đầu tiên có mạng và khi ứng dụng báo **Sẵn sàng offline**, có thể dùng ứng dụng khi không có Internet. Ảnh và tài liệu được lưu trong bộ nhớ của ứng dụng trên iPhone.

## Cài trên điện thoại

1. Mở [myscan cho iPhone](https://nhhai-math.github.io/myscan/ios/) bằng **Safari** khi điện thoại đang có mạng.
2. Chờ trang tải xong và hiển thị **Sẵn sàng offline**. Nếu trang chưa mở được, cần bật GitHub Pages theo hướng dẫn bên dưới.
3. Bấm **Chia sẻ** trong Safari → **Thêm vào Màn hình chính**. Trên một số phiên bản iOS cần kéo xuống trong bảng chia sẻ để thấy lựa chọn này.
4. Đặt tên **myscan** và bấm **Thêm**. Mở lại bằng biểu tượng myscan trên màn hình chính, chờ báo **Sẵn sàng offline** một lần nữa, rồi bắt đầu quét.

Nếu trang mở trong trình duyệt của Zalo hoặc ứng dụng khác, chọn **Mở trong Safari** trước khi thêm vào màn hình chính. Cập nhật iPhone lên iOS 16.4 hoặc mới hơn nếu thiết bị cho phép.

Quét QR này bằng camera iPhone để mở địa chỉ cài ứng dụng. Địa chỉ chỉ hoạt động sau khi GitHub Pages đã được bật và triển khai thành công.

![QR mở myscan trên iPhone](myscan-ios-install-qr.png)

## Quét và xuất tài liệu

Tạo tài liệu, chọn **Chụp trang** để dùng camera hoặc **Thêm ảnh** để chọn từ thư viện ảnh của iPhone. Chụp nhiều trang, kiểm tra từng ảnh, chỉnh vùng cắt, xoay và đổi chế độ màu theo nhu cầu. Sắp xếp lại các trang trước khi xuất.

Chọn **Xuất PDF** → chọn khổ trang → **Chuẩn bị PDF**. Khi PDF đã sẵn sàng, bấm **Chia sẻ / Lưu vào Tệp** để mở bảng chia sẻ iOS, rồi chọn **Lưu vào Tệp** hoặc gửi qua ứng dụng bạn chọn. Hai lần bấm tách biệt giúp Safari mở được bảng chia sẻ sau khi xử lý tài liệu. Có thể chọn **Tải PDF**; nếu Safari mở bản xem trước, dùng nút **Chia sẻ** của bản xem trước để lưu vào Tệp. Xuất PDF quan trọng ra Tệp để giữ bản sao độc lập với dữ liệu ứng dụng.

Safari và biểu tượng trên màn hình chính có thể dùng các vùng lưu trữ riêng: nên tiếp tục quét bằng biểu tượng myscan đã cài. Không dùng chế độ duyệt riêng tư để lưu hồ sơ lâu dài. Xóa dữ liệu trang web hoặc xóa ứng dụng có thể xóa các tài liệu cục bộ; iOS cũng có thể thu hồi bộ nhớ trang web khi thiếu dung lượng. Nếu bộ nhớ không đủ, ứng dụng báo lỗi để bạn giải phóng dung lượng rồi thử lại.

Khi có phiên bản mới, ứng dụng cho phép bạn chọn thời điểm cập nhật. Lưu trang đang chỉnh trước khi đồng ý cập nhật.

## Bật địa chỉ cài ứng dụng trên GitHub

Mã nguồn và trang đã build nằm trong repository `nhhai-math/myscan`:

1. Mở **Settings → Pages** của repository.
2. Trong **Build and deployment**, chọn **Deploy from a branch**.
3. Chọn branch **main**, thư mục **/docs**, rồi **Save**.
4. Chờ GitHub Pages hoàn tất triển khai, sau đó mở `https://nhhai-math.github.io/myscan/ios/` bằng Safari.

Ứng dụng cần địa chỉ **HTTPS** để cài bộ nhớ offline. Không mở tệp `index.html` trực tiếp từ ứng dụng Tệp. GitHub Pages chỉ cung cấp mã ứng dụng; luồng quét, chỉnh ảnh và ghép PDF chạy trên iPhone.

## Build lại từ mã nguồn

Tại thư mục gốc repository, dùng Node.js theo `.nvmrc`:

```sh
npm ci
npm run build:ios
```

Build tạo `dist-ios/` để xem thử và `docs/ios/` để triển khai GitHub Pages. Service worker chỉ lưu bộ khung ứng dụng và các tài nguyên build, không lưu ảnh hay PDF vào cache mạng. Dữ liệu quét nằm trong IndexedDB cục bộ.

Khi thiết lập cloud hoặc kiểm thử mà cần giữ nguyên trang đã lưu trong Git, dùng:

```sh
npm run build:ios -- --local-only
```

Tùy chọn này chỉ tạo `dist-ios/` cùng service worker offline và không sửa `docs/ios/` hoặc `docs/.nojekyll`. Lệnh không có tùy chọn tiếp tục cập nhật trang triển khai trong `docs/ios/`.

Phiên bản này là **PWA cài bằng Safari**, phù hợp khi bạn chỉ có iPhone. Không có bộ cài `.ipa` native trong phiên bản này. Bản iOS native phát hành qua TestFlight hoặc App Store sẽ cần tài khoản Apple Developer và quy trình ký ứng dụng của Apple; không thể cài một tệp APK Android trên iPhone.
