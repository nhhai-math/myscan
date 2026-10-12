package com.nhhai.myscan.ui

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

object Ui {
    val background = Color.rgb(247, 249, 245)
    val primary = Color.rgb(10, 107, 88)
    val ink = Color.rgb(35, 57, 48)
    val muted = Color.rgb(112, 133, 116)
    val line = Color.rgb(223, 232, 216)
    val mint = Color.rgb(234, 242, 225)
    val danger = Color.rgb(174, 83, 61)

    fun Context.dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()

    fun background(color: Int, radius: Int, stroke: Int? = null, context: Context): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = context.dp(radius).toFloat()
            if (stroke != null) setStroke(context.dp(1), stroke)
        }

    fun text(context: Context, value: String, size: Float = 14f, color: Int = ink, bold: Boolean = false): TextView =
        TextView(context).apply {
            text = value
            textSize = size
            setTextColor(color)
            if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            includeFontPadding = true
        }

    fun button(context: Context, label: String, primary: Boolean = false, onClick: () -> Unit): Button =
        Button(context).apply {
            text = label
            textSize = 13f
            isAllCaps = false
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setTextColor(if (primary) Color.WHITE else Ui.primary)
            background = background(if (primary) Ui.primary else Color.WHITE, 12, if (primary) null else line, context)
            minHeight = context.dp(48)
            minimumHeight = context.dp(48)
            gravity = Gravity.CENTER
            setPadding(context.dp(14), context.dp(10), context.dp(14), context.dp(10))
            setOnClickListener { onClick() }
        }

    fun column(context: Context, padding: Int = 0): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(context.dp(padding), context.dp(padding), context.dp(padding), context.dp(padding))
    }

    fun row(context: Context): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }

    fun spacer(context: Context, height: Int): View = View(context).apply {
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.dp(height))
    }
}
