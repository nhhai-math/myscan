package com.nhhai.myscan.ui

import android.Manifest
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.TorchState
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

/** Native, offline capture. The caller imports [EXTRA_PHOTO_PATH], then deletes that temporary file. */
class CameraActivity : ComponentActivity() {
    companion object {
        const val EXTRA_PHOTO_PATH = "photoPath"
        private const val SAVED_PHOTO_NAME = "camera_photo_name"
        private const val SAVED_ORIENTATION = "camera_previous_orientation"
    }

    private lateinit var state: CameraCaptureState
    private lateinit var previewView: PreviewView
    private lateinit var imageView: ImageView
    private lateinit var guide: PaperGuideView
    private lateinit var permissionPanel: LinearLayout
    private lateinit var permissionTitle: TextView
    private lateinit var permissionMessage: TextView
    private lateinit var permissionButton: Button
    private lateinit var status: TextView
    private lateinit var liveControls: LinearLayout
    private lateinit var reviewControls: LinearLayout
    private lateinit var shutter: Button
    private lateinit var torchButton: Button
    private var provider: ProcessCameraProvider? = null
    private var preview: Preview? = null
    private var imageCapture: ImageCapture? = null
    private var camera: Camera? = null
    private var cameraOpen = false
    private var cameraProblem: String? = null
    private var startingCamera = false
    private var requestingPermission = false
    private var previewBitmap: Bitmap? = null
    private var displayedPhoto: File? = null
    private val captureExecutor = Executors.newSingleThreadExecutor()
    private val captureDirectory by lazy { File(cacheDir, "scan-camera") }
    private val permissionHistory by lazy { getSharedPreferences("scan_camera_permissions", MODE_PRIVATE) }
    private val stateListener: () -> Unit = {
        restoreCaptureOrientation()
        renderState()
        if (!state.capturing && state.photo == null && hasCameraPermission()) startCamera()
    }

    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        requestingPermission = false
        if (granted) startCamera() else showPermissionRequired()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.rgb(13, 22, 36)
        window.navigationBarColor = Color.rgb(13, 22, 36)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        state = ViewModelProvider(this)[CameraCaptureState::class.java]
        if (state.originalOrientation == null && savedInstanceState?.containsKey(SAVED_ORIENTATION) == true) {
            state.originalOrientation = savedInstanceState.getInt(SAVED_ORIENTATION)
        }
        // ViewModel owns in-flight captures during rotation. Restore a completed photo after process death.
        if (state.photo == null && !state.capturing) {
            savedInstanceState?.getString(SAVED_PHOTO_NAME)?.let { filename ->
                if (Regex("[0-9a-fA-F-]{36}\\.jpg").matches(filename)) {
                    val file = File(captureDirectory, filename)
                    if (file.isFile && file.length() > 0) state.photo = file else file.delete()
                }
            }
        }
        buildContent()
        state.onChanged = stateListener
        restoreCaptureOrientation()
        renderState()
        if (state.photo == null && !state.capturing && !hasCameraPermission() &&
            !permissionHistory.getBoolean("requested", false)) requestCameraPermission()
    }

    override fun onResume() {
        super.onResume()
        if (state.photo == null && !state.capturing) {
            if (hasCameraPermission()) startCamera() else if (!requestingPermission) showPermissionRequired()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        state.photo?.let { outState.putString(SAVED_PHOTO_NAME, it.name) }
        state.originalOrientation?.let { outState.putInt(SAVED_ORIENTATION, it) }
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        if (state.onChanged === stateListener) state.onChanged = null
        unbindOwnCamera()
        captureExecutor.shutdown()
        imageView.setImageDrawable(null)
        previewBitmap?.recycle()
        previewBitmap = null
        super.onDestroy()
    }

    private fun buildContent() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(13, 22, 36))
            setPadding(dp(16), dp(12), dp(16), dp(16))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safeArea = insets.getInsets(WindowInsetsCompat.Type.systemBars() or
                WindowInsetsCompat.Type.displayCutout())
            view.setPadding(dp(16) + safeArea.left, dp(12) + safeArea.top,
                dp(16) + safeArea.right, dp(16) + safeArea.bottom)
            insets
        }
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(button("Đóng") { finish() }, LinearLayout.LayoutParams(dp(82), dp(48)))
        header.addView(label("Quét tài liệu", 22f, Color.WHITE).apply {
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(0, dp(48), 1f))
        header.addView(View(this), LinearLayout.LayoutParams(dp(82), 1))
        root.addView(header)
        root.addView(label("Đặt trọn trang giấy trong khung, tránh bóng và giữ máy ổn định.", 14f,
            Color.rgb(184, 195, 211)).apply { setPadding(0, dp(12), 0, dp(12)) })

        val stage = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        previewView = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            contentDescription = "Hình ảnh trực tiếp từ camera"
        }
        stage.addView(previewView, FrameLayout.LayoutParams(-1, -1))
        guide = PaperGuideView(this)
        stage.addView(guide, FrameLayout.LayoutParams(-1, -1))
        imageView = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "Ảnh vừa chụp để kiểm tra trước khi thêm vào tài liệu"
        }
        stage.addView(imageView, FrameLayout.LayoutParams(-1, -1))

        permissionPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(24))
            setBackgroundColor(Color.rgb(19, 30, 46))
        }
        permissionTitle = label("Cho phép sử dụng camera", 21f, Color.WHITE).apply { gravity = Gravity.CENTER }
        permissionMessage = label("myscan dùng camera để chụp tài liệu trên điện thoại.", 15f,
            Color.rgb(192, 202, 216)).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, dp(20))
        }
        permissionButton = button("Cho phép camera") { requestCameraPermission() }
        permissionPanel.addView(permissionTitle)
        permissionPanel.addView(permissionMessage)
        permissionPanel.addView(permissionButton, LinearLayout.LayoutParams(-1, dp(52)))
        stage.addView(permissionPanel, FrameLayout.LayoutParams(-1, -1))
        root.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))

        status = label("", 14f, Color.rgb(184, 195, 211)).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(12))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        root.addView(status, LinearLayout.LayoutParams(-1, -2))
        liveControls = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        torchButton = button("Đèn: Tắt") { toggleTorch() }.apply { isEnabled = false }
        shutter = button("Chụp trang") { takePhoto() }.apply {
            isEnabled = false
            setTextColor(Color.WHITE)
            backgroundTintList = android.content.res.ColorStateList.valueOf(Color.rgb(10, 107, 88))
        }
        liveControls.addView(torchButton, LinearLayout.LayoutParams(0, dp(56), 1f).apply { marginEnd = dp(12) })
        liveControls.addView(shutter, LinearLayout.LayoutParams(0, dp(56), 2f))
        root.addView(liveControls)

        reviewControls = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        reviewControls.addView(button("Chụp lại") {
            releasePreviewBitmap()
            state.discardPhoto()
            startCamera()
        }, LinearLayout.LayoutParams(0, dp(56), 1f).apply { marginEnd = dp(12) })
        reviewControls.addView(button("Dùng ảnh này") {
            val photo = state.photo
            if (!state.capturing && photo != null && photo.isFile && photo.length() > 0) {
                state.accepted = true
                setResult(RESULT_OK, Intent().putExtra(EXTRA_PHOTO_PATH, photo.absolutePath))
                finish()
            }
        }.apply {
            setTextColor(Color.WHITE)
            backgroundTintList = android.content.res.ColorStateList.valueOf(Color.rgb(10, 107, 88))
        }, LinearLayout.LayoutParams(0, dp(56), 2f))
        root.addView(reviewControls)
        setContentView(root)
        ViewCompat.requestApplyInsets(root)
        previewView.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_UP && !state.capturing) {
                camera?.let { current ->
                    val point = previewView.meteringPointFactory.createPoint(event.x, event.y)
                    current.cameraControl.startFocusAndMetering(FocusMeteringAction.Builder(point)
                        .setAutoCancelDuration(3, TimeUnit.SECONDS).build())
                }
                previewView.performClick()
            }
            true
        }
    }

    private fun renderState() {
        if (isDestroyed || isFinishing) return
        val photo = state.photo
        val reviewing = photo != null && !state.capturing
        reviewControls.visibility = if (reviewing) View.VISIBLE else View.GONE
        liveControls.visibility = if (reviewing) View.GONE else View.VISIBLE
        imageView.visibility = if (reviewing) View.VISIBLE else View.GONE
        previewView.visibility = if (reviewing) View.GONE else View.VISIBLE
        guide.visibility = if (reviewing) View.GONE else View.VISIBLE
        if (reviewing && photo != null) {
            permissionPanel.visibility = View.GONE
            unbindOwnCamera()
            if (displayedPhoto != photo) {
                releasePreviewBitmap()
                try {
                    previewBitmap = decodePreview(photo)
                    imageView.setImageBitmap(previewBitmap)
                    displayedPhoto = photo
                } catch (_: Exception) {
                    state.discardPhoto("Không đọc được ảnh vừa chụp. Hãy chụp lại trang.")
                    startCamera()
                    return
                }
            }
            status.text = "Kiểm tra độ rõ của chữ. Bạn có thể cắt góc và chỉnh ảnh sau khi thêm trang."
        } else {
            shutter.isEnabled = imageCapture != null && cameraOpen && !state.capturing && hasCameraPermission()
            torchButton.isEnabled = cameraOpen && camera?.cameraInfo?.hasFlashUnit() == true && !state.capturing
            status.text = when {
                state.capturing -> "Đang lưu ảnh…"
                cameraProblem != null -> cameraProblem
                state.error != null -> state.error
                cameraOpen -> "Chạm vào trang để lấy nét · Bấm Chụp trang khi ảnh rõ"
                else -> "Đang chuẩn bị camera…"
            }
            if (cameraProblem != null && !state.capturing) showCameraUnavailable()
        }
    }

    private fun hasCameraPermission() = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED

    private fun requestCameraPermission() {
        if (hasCameraPermission()) {
            startCamera()
            return
        }
        if (!requestingPermission) {
            permissionHistory.edit().putBoolean("requested", true).apply()
            requestingPermission = true
            permissionRequest.launch(Manifest.permission.CAMERA)
        }
    }

    private fun showPermissionRequired() {
        if (state.photo != null && !state.capturing) return
        unbindOwnCamera()
        permissionPanel.visibility = View.VISIBLE
        permissionTitle.text = "Cho phép sử dụng camera"
        val openSettings = permissionHistory.getBoolean("requested", false) &&
            !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
        permissionMessage.text = if (openSettings)
            "Camera chưa được cho phép. Mở cài đặt của myscan, chọn Quyền và cho phép Camera để tiếp tục."
        else "myscan cần quyền camera để chụp tài liệu. Ảnh được lưu và xử lý trên điện thoại."
        permissionButton.text = if (openSettings) "Mở cài đặt" else "Cho phép camera"
        permissionButton.setOnClickListener {
            if (openSettings) startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName"))) else requestCameraPermission()
        }
        shutter.isEnabled = false
        torchButton.isEnabled = false
        status.text = "Bạn có thể đóng màn hình này để nhập ảnh có sẵn từ thư viện."
    }

    private fun startCamera() {
        if (isFinishing || isDestroyed || startingCamera || state.photo != null || state.capturing) return
        if (!hasCameraPermission()) {
            if (!requestingPermission) showPermissionRequired()
            return
        }
        if (imageCapture != null) {
            permissionPanel.visibility = View.GONE
            renderState()
            return
        }
        startingCamera = true
        permissionPanel.visibility = View.GONE
        status.text = "Đang mở camera…"
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            startingCamera = false
            if (isFinishing || isDestroyed || state.photo != null || state.capturing) return@addListener
            try {
                val cameraProvider = future.get()
                provider = cameraProvider
                val selector = when {
                    cameraProvider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
                    cameraProvider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
                    else -> throw IllegalStateException("Thiết bị không có camera khả dụng.")
                }
                val newPreview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                val capture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                    .setFlashMode(ImageCapture.FLASH_MODE_OFF)
                    .setIoExecutor(captureExecutor)
                    .build()
                preview = newPreview
                imageCapture = capture
                camera = cameraProvider.bindToLifecycle(this, selector, newPreview, capture)
                camera?.cameraInfo?.torchState?.observe(this) { torch ->
                    torchButton.text = if (torch == TorchState.ON) "Đèn: Bật" else "Đèn: Tắt"
                }
                torchButton.text = if (camera?.cameraInfo?.hasFlashUnit() == true) "Đèn: Tắt" else "Không có đèn"
                camera?.cameraInfo?.cameraState?.observe(this) { cameraState ->
                    cameraOpen = cameraState.type == CameraState.Type.OPEN && cameraState.error == null
                    cameraProblem = if (cameraState.error != null)
                        "Camera đang bận hoặc chưa sẵn sàng. Hãy thử lại." else null
                    if (state.photo == null && !state.capturing) {
                        if (cameraProblem == null) permissionPanel.visibility = View.GONE
                        renderState()
                    }
                }
                state.error = null
                renderState()
            } catch (_: Exception) {
                unbindOwnCamera()
                cameraProblem = "Camera chưa sẵn sàng"
                showCameraUnavailable()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun takePhoto() {
        val capture = imageCapture ?: return
        if (state.capturing || state.photo != null || !cameraOpen || !hasCameraPermission()) return
        if (!captureDirectory.isDirectory && !captureDirectory.mkdirs()) {
            state.error = "Không tạo được nơi lưu ảnh. Hãy kiểm tra dung lượng điện thoại."
            renderState()
            return
        }
        val file = File(captureDirectory, "${UUID.randomUUID()}.jpg")
        state.photo = file
        state.capturing = true
        state.error = null
        state.originalOrientation = requestedOrientation
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LOCKED
        renderState()
        previewView.display?.let { capture.targetRotation = it.rotation }
        try {
            capture.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(this),
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                        if (state.closed) {
                            file.delete()
                            return
                        }
                        state.capturing = false
                        state.onChanged?.invoke()
                    }

                    override fun onError(exception: ImageCaptureException) {
                        file.delete()
                        if (state.closed) return
                        state.photo = null
                        state.capturing = false
                        state.error = "Chụp ảnh chưa thành công. Giữ máy ổn định và thử lại."
                        state.onChanged?.invoke()
                    }
                })
        } catch (_: Exception) {
            state.discardPhoto("Chụp ảnh chưa thành công. Hãy thử lại.")
        }
    }

    private fun toggleTorch() {
        val current = camera ?: return
        if (!current.cameraInfo.hasFlashUnit() || state.capturing) return
        val enabled = current.cameraInfo.torchState.value != TorchState.ON
        val future = current.cameraControl.enableTorch(enabled)
        future.addListener({
            if (!isDestroyed && !isFinishing) {
                try {
                    future.get()
                } catch (_: Exception) {
                    status.text = "Không bật được đèn. Hãy dùng nguồn sáng bên ngoài."
                }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun unbindOwnCamera() {
        camera?.cameraInfo?.torchState?.removeObservers(this)
        camera?.cameraInfo?.cameraState?.removeObservers(this)
        camera?.cameraControl?.enableTorch(false)
        preview?.let { provider?.unbind(it) }
        imageCapture?.let { provider?.unbind(it) }
        camera = null
        preview = null
        imageCapture = null
        cameraOpen = false
        cameraProblem = null
    }

    private fun showCameraUnavailable() {
        permissionPanel.visibility = View.VISIBLE
        permissionTitle.text = "Không mở được camera"
        permissionMessage.text = "Đóng ứng dụng khác đang dùng camera rồi thử lại. Bạn cũng có thể quay lại và nhập ảnh từ thư viện."
        permissionButton.text = "Thử lại"
        permissionButton.setOnClickListener {
            unbindOwnCamera()
            startCamera()
        }
        shutter.isEnabled = false
        torchButton.isEnabled = false
        status.text = cameraProblem ?: "Camera chưa sẵn sàng"
    }

    private fun restoreCaptureOrientation() {
        if (!state.capturing) state.originalOrientation?.let { orientation ->
            state.originalOrientation = null
            requestedOrientation = orientation
        }
    }

    private fun releasePreviewBitmap() {
        imageView.setImageDrawable(null)
        previewBitmap?.recycle()
        previewBitmap = null
        displayedPhoto = null
    }

    private fun decodePreview(file: File): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Invalid photo" }
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > 1800) sample *= 2
        val original = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: error("Could not decode photo")
        val orientation = try {
            ExifInterface(file).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } catch (error: Exception) {
            original.recycle()
            throw error
        }
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
        }
        if (matrix.isIdentity) return original
        return try {
            Bitmap.createBitmap(original, 0, 0, original.width, original.height, matrix, true).also {
                if (it !== original) original.recycle()
            }
        } catch (error: Exception) {
            original.recycle()
            throw error
        }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()

    private fun label(text: String, size: Float, color: Int) = TextView(this).apply {
        this.text = text
        textSize = size
        setTextColor(color)
    }

    private fun button(text: String, action: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        textSize = 15f
        minimumHeight = dp(48)
        setPadding(dp(8), 0, dp(8), 0)
        setTextColor(Color.rgb(13, 22, 36))
        backgroundTintList = android.content.res.ColorStateList.valueOf(Color.rgb(231, 237, 247))
        setOnClickListener { action() }
    }
}

/** Keeps CameraX's callback attached to the current activity during a configuration change. */
class CameraCaptureState : ViewModel() {
    var photo: File? = null
    var capturing = false
    var accepted = false
    var closed = false
    var error: String? = null
    var originalOrientation: Int? = null
    var onChanged: (() -> Unit)? = null

    fun discardPhoto(message: String? = null) {
        photo?.delete()
        photo = null
        capturing = false
        error = message
        onChanged?.invoke()
    }

    override fun onCleared() {
        closed = true
        onChanged = null
        if (!accepted) photo?.delete()
    }
}

/** A framing guide only; capture stays manual so it never claims to detect paper automatically. */
private class PaperGuideView(context: android.content.Context) : View(context) {
    private val mask = Paint().apply { color = 0x77000000 }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(209, 225, 255)
        style = Paint.Style.STROKE
        strokeWidth = 3f * resources.displayMetrics.density
        strokeCap = Paint.Cap.ROUND
    }

    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val frameWidth = min(width * .85f, height * .82f * .707f)
        val frameHeight = frameWidth / .707f
        val frame = RectF((width - frameWidth) / 2f, (height - frameHeight) / 2f,
            (width + frameWidth) / 2f, (height + frameHeight) / 2f)
        canvas.drawRect(0f, 0f, width.toFloat(), frame.top, mask)
        canvas.drawRect(0f, frame.bottom, width.toFloat(), height.toFloat(), mask)
        canvas.drawRect(0f, frame.top, frame.left, frame.bottom, mask)
        canvas.drawRect(frame.right, frame.top, width.toFloat(), frame.bottom, mask)
        val length = min(frameWidth, frameHeight) * .1f
        for ((x, y, sx, sy) in listOf(
            floatArrayOf(frame.left, frame.top, 1f, 1f),
            floatArrayOf(frame.right, frame.top, -1f, 1f),
            floatArrayOf(frame.left, frame.bottom, 1f, -1f),
            floatArrayOf(frame.right, frame.bottom, -1f, -1f))) {
            canvas.drawLine(x, y, x + length * sx, y, line)
            canvas.drawLine(x, y, x, y + length * sy, line)
        }
    }
}
