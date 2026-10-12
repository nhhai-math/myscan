# myscan Android

Ứng dụng Android native bằng **Kotlin + CameraX**, quét và hoàn thiện tài liệu **offline ngay trên điện thoại**. Android **8.0 trở lên**.

## Cài bản thử nghiệm

**[Tải APK Android 1.0.0](https://github.com/nhhai-math/myscan/raw/refs/heads/main/downloads/myscan-android-1.0.0-debug.apk)** hoặc mở [hướng dẫn tải bằng QR](../docs/android-download.md).

[![QR tải myscan Android](../docs/myscan-android-download-qr.png)](https://github.com/nhhai-math/myscan/raw/refs/heads/main/downloads/myscan-android-1.0.0-debug.apk)

Mở liên kết hoặc quét QR trên điện thoại, tải APK rồi mở tệp để cài. Cho phép cài từ ứng dụng đang mở tệp nếu Android yêu cầu. Đây là APK thử nghiệm được ký bằng khóa debug, chưa phải bản phát hành trên Google Play. Chỉ cần Internet để tải bộ cài; sử dụng ứng dụng offline sau khi cài.

Nếu tự build, tệp APK nằm tại `app/build/outputs/apk/debug/app-debug.apk`.

Ứng dụng chỉ xin quyền **Camera** khi chụp. Nhập ảnh và lưu PDF dùng bộ chọn tệp Android, không xin quyền đọc toàn bộ bộ nhớ. APK không khai báo quyền Internet; camera, chỉnh ảnh, lưu tài liệu và PDF hoạt động không cần máy chủ hoặc tài khoản.

## Sử dụng

1. Chọn **Tài liệu mới** và đặt tên, hoặc **Bắt đầu quét**.
2. **Quét bằng camera**: lấy trọn bốn góc giấy, chạm để lấy nét, chụp, xem lại và chọn **Dùng ảnh này**. Có thể chụp lại hoặc bật đèn khi camera hỗ trợ. **Thêm ảnh có sẵn** cho phép nhập tối đa 20 ảnh/lần.
3. **Chỉnh sửa**: kéo bốn điểm theo mép giấy; xoay 90°; chọn màu, thang xám hoặc đen trắng; chỉnh độ sáng và tương phản. **Xem kết quả** trước khi **Lưu trang**. Lần mở tiếp theo giữ lại thiết lập đã lưu.
4. Dùng **Trang trước/Trang sau**, **↑/↓** để đổi thứ tự hoặc menu **Sắp xếp các trang** để chọn nhanh trang. Có thể xem riêng **Ảnh gốc**, đổi tên, xóa trang hoặc tài liệu.
5. **Xuất PDF** chọn A4 hoặc theo tỷ lệ ảnh; **Lưu PDF** chọn thư mục trên điện thoại, **Chia sẻ PDF** gửi qua ứng dụng bạn chọn.

Ảnh gốc sau chuẩn hóa EXIF và ảnh đã chỉnh được giữ riêng. Các lần chỉnh luôn dựng lại từ ảnh nguồn để tránh giảm chất lượng do chỉnh lặp. Việc cắt/căn bốn góc là thao tác do người dùng điều chỉnh.

## Dữ liệu

- Tài liệu nằm trong thư mục riêng `files/myscan` của ứng dụng, gồm `metadata.json` và ảnh gốc/bản chỉnh của từng trang.
- Ảnh nhập tối đa 32 MB, 100 triệu điểm ảnh; ảnh nguồn chuẩn hóa tối đa 4000 px cạnh dài. Bản chỉnh tối đa 2600 px. Mỗi tài liệu tối đa 200 trang.
- Metadata ghi nguyên tử; nếu chỉ mục hỏng, ứng dụng báo lỗi và giữ nguyên dữ liệu để khôi phục.
- Thư viện tồn tại sau khi đóng/mở ứng dụng. **Gỡ ứng dụng hoặc xóa dữ liệu ứng dụng sẽ xóa thư viện**; hãy lưu/chia sẻ PDF cần giữ trước thao tác này.

## Build với Android Studio

Mở thư mục `android/` trong Android Studio. Cần JDK **17 trở lên** (cloud đã kiểm tra JDK21), SDK **35**, Build Tools **35.0.0**. Gradle Wrapper **8.13**, Android Gradle Plugin **8.11.1**, Kotlin **2.1.20** đã được pin trong dự án.

```bash
./gradlew :app:assembleDebug :app:testDebugUnitTest
```

Trên Windows:

```powershell
cd D:\Apps\myscan\android
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest
```

Android Studio tự tạo `local.properties` với SDK trên máy của bạn. Nếu dùng dòng lệnh, đặt `ANDROID_HOME` tới SDK. Không chép đường dẫn SDK cloud vào cấu hình của máy Windows.

## Build trong cloud này

Từ `/workspace/myscan`:

```bash
bash scripts/setup-android-cloud.sh
source /workspace/.toolchains/android-env.sh
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest --no-daemon --console=plain
```

Script cloud cài công cụ dưới `/workspace/.toolchains`, dùng gói Debian có metadata ký và checksum chính thức của Google/Gradle. Các bản đã cài được dùng lại; không thay đổi mã nguồn ứng dụng hay vô hiệu hóa TLS.

## Kiểm thử trên Android

Với điện thoại/giả lập đã bật ADB:

```bash
./gradlew :app:connectedDebugAndroidTest --no-daemon --console=plain
```

Kiểm thử JVM kiểm tra metadata, thông số chỉnh ảnh và hình học. Kiểm thử Android kiểm tra EXIF, phối cảnh, bộ lọc, giữ nguyên ảnh nguồn, lưu thiết lập, xuất/đọc PDF đúng thứ tự và bảo toàn dữ liệu lỗi. Thư viện thử được tạo riêng, không ghi vào tài liệu thật của người dùng.

Cloud có bộ giả lập Android15/API35 chạy bằng CPU, chưa có tăng tốc KVM. Bộ cài giả lập tùy chọn ở `scripts/setup-android-emulator.sh`; có thể dùng thiết bị Android/giả lập của Android Studio để chạy cùng bộ kiểm thử.

Khóa ký release và việc phát hành Google Play chưa được cấu hình. Chỉ APK debug được tạo cho cài thử.
