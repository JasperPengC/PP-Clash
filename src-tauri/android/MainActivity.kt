package com.ppclash.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            val imeDp = (insets.getInsets(WindowInsetsCompat.Type.ime()).bottom / resources.displayMetrics.density).toInt()
            webView.post {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('ppclash-ime',{detail:{bottom:$imeDp}}))",
                    null,
                )
            }
            insets
        }
        ViewCompat.requestApplyInsets(window.decorView)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                isEnabled = false
                webView.evaluateJavascript("Boolean(window.ppclashAndroidBack?.())") { handled ->
                    isEnabled = true
                    if (handled != "true" && !isFinishing) moveTaskToBack(true)
                }
            }
        })
    }
}
