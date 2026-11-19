package com.ppclash.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
import androidx.core.content.ContextCompat
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import mobile.Mobile
import mobile.SocketProtector
import java.util.concurrent.Executors

class ClashVpnService : VpnService(), SocketProtector {
    // Only the worker reads or closes the descriptor.
    private var descriptor: ParcelFileDescriptor? = null
    private var stopping = false
    private var destroyed = false

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            shutdown()
            return START_NOT_STICKY
        }
        val request = pendingStart
        pendingStart = null
        if (request == null || stopping) {
            request?.reply?.reject("VPN 正在停止")
            if (!running && !starting) stopSelf(startId)
            return START_NOT_STICKY
        }
        starting = true
        try {
            showNotification(false)
        } catch (exception: Exception) {
            starting = false
            request.reply.reject(exception.message ?: "无法启动 VPN 前台服务")
            stopSelf(startId)
            return START_NOT_STICKY
        }
        worker.execute {
            val error = runCatching {
                descriptor = Builder()
                    .setSession("PP Clash")
                    .setMtu(1500)
                    .setBlocking(false)
                    .addAddress("172.19.0.1", 30)
                    .addAddress("fdfe:dcba:9876::1", 126)
                    .addRoute("0.0.0.0", 0)
                    .addRoute("::", 0)
                    .addDnsServer("172.19.0.2")
                    .establish() ?: error("系统未能建立 VPN，检查授权后重试")
                Mobile.start(request.path, checkNotNull(descriptor).fd, this)
            }.exceptionOrNull()
            if (error != null) releaseCore()
            mainExecutorCompat {
                starting = false
                when {
                    stopping || destroyed -> request.reply.reject("VPN 启动已取消")
                    error != null -> {
                        request.reply.reject(error.message ?: "无法启动 mihomo")
                        stopForeground(STOP_FOREGROUND_REMOVE)
                        stopSelf(startId)
                    }
                    else -> {
                        running = true
                        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                            .notify(NOTIFICATION_ID, notification(true))
                        request.reply.resolve(status())
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onRevoke() {
        mainExecutorCompat { shutdown() }
    }

    override fun onDestroy() {
        destroyed = true
        if (instance === this) {
            instance = null
            running = false
            starting = false
        }
        if (!stopping) worker.execute { releaseCore() }
        super.onDestroy()
    }

    private fun shutdown(reply: Invoke? = null) {
        if (stopping) {
            reply?.reject("VPN 正在停止")
            return
        }
        stopping = true
        worker.execute {
            releaseCore()
            mainExecutorCompat {
                running = false
                reply?.resolve(status())
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    private fun releaseCore() {
        try {
            runCatching { Mobile.stop() }
        } finally {
            runCatching { descriptor?.close() }
            descriptor = null
        }
    }

    private fun mainExecutorCompat(block: () -> Unit) {
        ContextCompat.getMainExecutor(this).execute { block() }
    }

    private fun showNotification(connected: Boolean) {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "VPN 连接", NotificationManager.IMPORTANCE_LOW))
        }
        val notification = notification(connected)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @Suppress("DEPRECATION")
    private fun notification(connected: Boolean): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, ClashVpnService::class.java)
            .setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        return builder.setSmallIcon(R.drawable.ic_stat_ppclash)
            .setContentTitle("PP Clash")
            .setContentText(if (connected) "VPN 已连接" else "正在连接 VPN")
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "断开", stop).build())
            .build()
    }

    private data class StartRequest(val path: String, val reply: Invoke)

    companion object {
        private const val CHANNEL_ID = "ppclash-vpn"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_DISCONNECT = "com.ppclash.app.DISCONNECT_VPN"

        internal val worker = Executors.newSingleThreadExecutor()
        private var instance: ClashVpnService? = null
        private var pendingStart: StartRequest? = null
        private var starting = false
        @Volatile private var running = false

        internal fun status(): JSObject {
            val connected = running
            return JSObject().put("running", connected).apply {
                if (connected) put("pid", Process.myPid())
            }
        }

        internal fun connect(context: Context, path: String, reply: Invoke) {
            if (running) {
                reply.resolve(status())
                return
            }
            if (pendingStart != null || starting || instance?.stopping == true) {
                reply.reject("VPN 正在切换状态，请稍后重试")
                return
            }
            pendingStart = StartRequest(path, reply)
            try {
                ContextCompat.startForegroundService(context, Intent(context, ClashVpnService::class.java))
            } catch (exception: Exception) {
                pendingStart = null
                reply.reject(exception.message ?: "无法启动 VPN 服务")
            }
        }

        internal fun disconnect(reply: Invoke) {
            val service = instance
            if (service != null) {
                service.shutdown(reply)
            } else {
                pendingStart?.reply?.reject("VPN 启动已取消")
                pendingStart = null
                reply.resolve(status())
            }
        }
    }
}
