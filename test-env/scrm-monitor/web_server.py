#!/usr/bin/env python3
"""
SCRM Scraper Web Management Interface v2
简单网页管理SCRM爬虫配置 - 优化链接添加体验
"""

import json
import os
import re
from flask import Flask, render_template_string, request, redirect, url_for, flash, jsonify

app = Flask(__name__)
app.secret_key = 'scrm-scraper-secret-key'

# 配置文件路径：优先环境变量，其次默认路径
CONFIG_FILE = os.environ.get('CONFIG_FILE', "E:/hanako/scrm-monitor/config.json")

# HTML template v2 - 优化链接添加体验
HTML_TEMPLATE = r"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SCRM Scraper 管理 v2</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 680px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #409eff 0%, #36d1dc 100%);
            color: white;
            padding: 24px 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 22px;
            font-weight: 600;
            margin-bottom: 6px;
        }
        
        .header p {
            font-size: 13px;
            opacity: 0.9;
        }
        
        .tabs {
            display: flex;
            border-bottom: 2px solid #e0e6ed;
            background: #f8f9fa;
        }
        
        .tab {
            flex: 1;
            padding: 12px 16px;
            text-align: center;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            color: #909399;
            border-bottom: 2px solid transparent;
            margin-bottom: -2px;
            transition: all 0.2s;
        }
        
        .tab:hover {
            color: #409eff;
        }
        
        .tab.active {
            color: #409eff;
            border-bottom-color: #409eff;
            background: white;
        }
        
        .tab-content {
            display: none;
            padding: 24px 30px;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .form-group {
            margin-bottom: 18px;
        }
        
        label {
            display: block;
            font-weight: 600;
            color: #333;
            margin-bottom: 8px;
            font-size: 14px;
        }
        
        .input-group {
            position: relative;
        }
        
        input[type="text"],
        input[type="password"],
        input[type="time"],
        textarea {
            width: 100%;
            padding: 10px 14px;
            border: 2px solid #e0e6ed;
            border-radius: 8px;
            font-size: 14px;
            transition: all 0.2s ease;
            background: #f8f9fa;
            font-family: inherit;
        }
        
        input:focus,
        textarea:focus {
            outline: none;
            border-color: #409eff;
            background: white;
            box-shadow: 0 0 0 4px rgba(64, 158, 255, 0.1);
        }
        
        textarea {
            min-height: 70px;
            resize: vertical;
        }
        
        .help-text {
            font-size: 12px;
            color: #909399;
            margin-top: 6px;
            line-height: 1.5;
        }
        
        .help-text code {
            background: #f0f2f5;
            padding: 1px 6px;
            border-radius: 4px;
            font-size: 11px;
            color: #606266;
        }
        
        .btn-group {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        
        .btn {
            flex: 1;
            padding: 12px 20px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            font-family: inherit;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #409eff 0%, #36d1dc 100%);
            color: white;
        }
        
        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(64, 158, 255, 0.3);
        }
        
        .btn-secondary {
            background: #f0f2f5;
            color: #606266;
        }
        
        .btn-secondary:hover {
            background: #e4e7ed;
        }
        
        .btn-sm {
            padding: 6px 14px;
            font-size: 12px;
            flex: none;
        }
        
        .btn-success {
            background: #67c23a;
            color: white;
        }
        
        .btn-success:hover {
            background: #85ce61;
        }
        
        .flash-message {
            padding: 12px 16px;
            margin: 12px 30px 0;
            border-radius: 8px;
            font-size: 13px;
        }
        
        .flash-success {
            background: #f0f9eb;
            color: #67c23a;
            border: 1px solid #c2e7b0;
        }
        
        .flash-error {
            background: #fef0f0;
            color: #f56c6c;
            border: 1px solid #fbc4c4;
        }
        
        .current-value {
            background: #f0f7ff;
            padding: 8px 12px;
            border-radius: 6px;
            margin-bottom: 8px;
            font-size: 12px;
            color: #409eff;
            border: 1px solid #d9ecff;
            word-break: break-all;
            line-height: 1.5;
        }
        
        .current-value-label {
            font-weight: 600;
            margin-bottom: 2px;
            color: #606266;
        }
        
        .footer {
            background: #f8f9fa;
            padding: 14px 30px;
            text-align: center;
            font-size: 11px;
            color: #909399;
            border-top: 1px solid #ebeef5;
        }
        
        .agent-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 8px;
        }
        
        .agent-tag {
            background: #ecf5ff;
            color: #409eff;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 12px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        
        .agent-tag .remove {
            cursor: pointer;
            font-weight: bold;
            opacity: 0.6;
        }
        
        .agent-tag .remove:hover {
            opacity: 1;
        }
        
        .paste-box {
            border: 2px dashed #dcdfe6;
            border-radius: 8px;
            padding: 16px;
            text-align: center;
            background: #fafafa;
            margin-bottom: 12px;
            transition: all 0.2s;
        }
        
        .paste-box:hover {
            border-color: #409eff;
            background: #f0f7ff;
        }
        
        .paste-box textarea {
            border: none;
            background: transparent;
            resize: none;
            text-align: center;
            color: #909399;
            font-size: 13px;
        }
        
        .paste-box textarea:focus {
            outline: none;
            box-shadow: none;
            background: transparent;
        }
        
        .quick-actions {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
            flex-wrap: wrap;
        }
        
        .quick-btn {
            padding: 6px 12px;
            background: #f0f2f5;
            border: none;
            border-radius: 6px;
            font-size: 12px;
            color: #606266;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .quick-btn:hover {
            background: #e4e7ed;
            color: #409eff;
        }
        
        .parse-result {
            background: #f0f9eb;
            border: 1px solid #c2e7b0;
            border-radius: 8px;
            padding: 10px 14px;
            margin-top: 10px;
            font-size: 13px;
            color: #67c23a;
            display: none;
        }
        
        .parse-result.show {
            display: block;
        }
        
        .parse-result-error {
            background: #fef0f0;
            border-color: #fbc4c4;
            color: #f56c6c;
        }
        
        .status-card {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 12px 16px;
            margin-bottom: 16px;
        }
        
        .status-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            font-size: 13px;
            border-bottom: 1px solid #ebeef5;
        }
        
        .status-row:last-child {
            border-bottom: none;
        }
        
        .status-label {
            color: #909399;
        }
        
        .status-value {
            font-weight: 500;
            color: #303133;
        }
        
        .status-value.ok {
            color: #67c23a;
        }
        
        .status-value.warn {
            color: #e6a23c;
        }
        
        .status-value.err {
            color: #f56c6c;
        }
        
        .mini-card {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 10px 12px;
            text-align: center;
        }
        
        .mini-card.green {
            background: #f0f9eb;
        }
        
        .mini-card.blue {
            background: #ecf5ff;
        }
        
        .mini-card.orange {
            background: #fdf6ec;
        }
        
        .mini-label {
            font-size: 11px;
            color: #909399;
            margin-bottom: 4px;
        }
        
        .mini-value {
            font-size: 20px;
            font-weight: 700;
            color: #303133;
        }
        
        .mini-card.green .mini-value { color: #67c23a; }
        .mini-card.blue .mini-value { color: #409eff; }
        .mini-card.orange .mini-value { color: #e6a23c; }
        
        .agent-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 10px;
            border-bottom: 1px solid #ebeef5;
            font-size: 13px;
        }
        
        .agent-row:last-child { border-bottom: none; }
        
        .agent-name {
            font-weight: 500;
            color: #303133;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .agent-badge {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #dcdfe6;
        }
        
        .agent-badge.online { background: #67c23a; box-shadow: 0 0 4px #67c23a; }
        .agent-badge.offline { background: #909399; }
        .agent-badge.inherited { background: #e6a23c; }
        .agent-badge.notfound { background: #f56c6c; }
        
        .agent-stats {
            display: flex;
            gap: 12px;
            font-size: 11px;
            color: #909399;
        }
        
        .agent-stats span b {
            color: #606266;
            font-weight: 600;
        }
        
        .agent-inherited-tag {
            font-size: 10px;
            background: #fdf6ec;
            color: #e6a23c;
            padding: 1px 6px;
            border-radius: 10px;
            margin-left: 4px;
        }
        
        .filter-btn {
            padding: 4px 12px;
            background: #f0f2f5;
            color: #606266;
            border-radius: 14px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
            user-select: none;
        }
        
        .filter-btn:hover {
            background: #e4e7ed;
            color: #409eff;
        }
        
        .filter-btn.active {
            background: #409eff;
            color: white;
        }
        
        .agent-card {
            background: #fafafa;
            border: 1px solid #ebeef5;
            border-radius: 8px;
            padding: 10px 12px;
            margin-bottom: 8px;
            transition: all 0.2s;
        }
        
        .agent-card:hover {
            border-color: #409eff;
            box-shadow: 0 2px 8px rgba(64,158,255,0.1);
        }
        
        .agent-card.online {
            border-left: 3px solid #67c23a;
        }
        
        .agent-card.offline {
            border-left: 3px solid #909399;
        }
        
        .agent-card.inherited {
            border-left: 3px solid #e6a23c;
            background: #fdf6ec;
        }
        
        .agent-card.notfound {
            border-left: 3px solid #f56c6c;
            background: #fef0f0;
        }
        
        .agent-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
        }
        
        .agent-card-name {
            font-weight: 600;
            color: #303133;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .agent-card-status {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            font-weight: 500;
        }
        
        .agent-card-status.online { background: #f0f9eb; color: #67c23a; }
        .agent-card-status.offline { background: #f4f4f5; color: #909399; }
        .agent-card-status.inherited { background: #fdf6ec; color: #e6a23c; }
        .agent-card-status.notfound { background: #fef0f0; color: #f56c6c; }
        
        .agent-card-nickname {
            font-size: 12px;
            color: #909399;
            margin-bottom: 6px;
        }
        
        .agent-card-progress {
            margin: 6px 0;
        }
        
        .progress-bar {
            height: 6px;
            background: #ebeef5;
            border-radius: 3px;
            overflow: hidden;
            margin-top: 4px;
        }
        
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #409eff, #36d1dc);
            border-radius: 3px;
            transition: width 0.3s;
        }
        
        .progress-fill.done {
            background: linear-gradient(90deg, #67c23a, #85ce61);
        }
        
        .progress-label {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #606266;
        }
        
        .progress-label b {
            color: #303133;
            font-weight: 600;
        }
        
        .agent-card-meta {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #909399;
            margin-top: 6px;
            padding-top: 6px;
            border-top: 1px dashed #ebeef5;
        }
        
        .agent-card-meta span {
            max-width: 60%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .cookie-section {
            background: #fff7e6;
            border: 1px solid #ffd591;
            border-radius: 8px;
            padding: 14px;
            margin-bottom: 16px;
        }
        
        .cookie-section h4 {
            color: #d46b08;
            margin-bottom: 8px;
            font-size: 14px;
        }
        
        .cookie-section p {
            font-size: 12px;
            color: #873800;
            line-height: 1.6;
        }
        
        @media (max-width: 480px) {
            .container {
                margin: 8px;
            }
            .header {
                padding: 18px 20px;
            }
            .tab-content {
                padding: 18px 20px;
            }
            .btn-group {
                flex-direction: column;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 SCRM Scraper 管理</h1>
            <p>配置爬虫参数 · 监控客服状态 · 同步 Cookie</p>
        </div>
        
        <div class="tabs">
            <div class="tab active" onclick="switchTab('monitor')">📊 监控</div>
            <div class="tab" onclick="switchTab('links')">🔗 链接/客服</div>
            <div class="tab" onclick="switchTab('settings')">⚙️ 参数设置</div>
            <div class="tab" onclick="switchTab('cookie')">🍪 Cookie</div>
        </div>
        
        {% with messages = get_flashed_messages(with_categories=true) %}
            {% if messages %}
                {% for category, message in messages %}
                    <div class="flash-message flash-{{ category }}">
                        {{ message }}
                    </div>
                {% endfor %}
            {% endif %}
        {% endwith %}
        
        <form method="POST" action="/save" id="main-form">
            <!-- 监控 -->
            <div id="tab-monitor" class="tab-content active">
                <div class="status-card">
                    <div class="status-row">
                        <span class="status-label">抓取状态</span>
                        <span class="status-value" id="mon-scrape-status">加载中...</span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">最近抓取</span>
                        <span class="status-value" id="mon-last-time">-</span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">监控客服</span>
                        <span class="status-value" id="mon-agent-count">-</span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">Cookie 状态</span>
                        <span class="status-value" id="mon-cookie-status">-</span>
                    </div>
                </div>
                
                <div class="form-group">
                    <label>📈 汇总数据</label>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                        <div class="mini-card">
                            <div class="mini-label">在线客服</div>
                            <div class="mini-value" id="mon-online">-</div>
                        </div>
                        <div class="mini-card">
                            <div class="mini-label">总客服</div>
                            <div class="mini-value" id="mon-total">-</div>
                        </div>
                        <div class="mini-card green">
                            <div class="mini-label">今日线索</div>
                            <div class="mini-value" id="mon-today-leads">-</div>
                        </div>
                        <div class="mini-card blue">
                            <div class="mini-label">总线索</div>
                            <div class="mini-value" id="mon-total-leads">-</div>
                        </div>
                    </div>
                </div>
                
                <div class="form-group">
                    <label>👥 客服详情 <span style="font-weight:normal;color:#909399;font-size:12px;">（点击刷新）</span></label>
                    <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
                      <span class="filter-btn active" onclick="filterAgents('all', this)">全部</span>
                      <span class="filter-btn" onclick="filterAgents('online', this)">在线</span>
                      <span class="filter-btn" onclick="filterAgents('offline', this)">离线</span>
                      <span class="filter-btn" onclick="filterAgents('inherited', this)">继承</span>
                      <span class="filter-btn" onclick="filterAgents('notfound', this)">未找到</span>
                    </div>
                    <div id="mon-agents-list" style="max-height:500px;overflow-y:auto;">
                        <div style="text-align:center;color:#909399;padding:30px;font-size:13px;">加载中...</div>
                    </div>
                </div>
                
                <div class="btn-group">
                    <button type="button" class="btn btn-primary" onclick="loadMonitorData()">🔄 刷新数据</button>
                </div>
            </div>
            
            <!-- 链接/客服 -->
            <div id="tab-links" class="tab-content">
                <div class="status-card">
                    <div class="status-row">
                        <span class="status-label">当前分享链接</span>
                        <span class="status-value" style="max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;">
                            {{ '✅ 已设置' if config.shareUrl else '❌ 未设置' }}
                        </span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">监控客服数</span>
                        <span class="status-value {{ 'ok' if config.agentIds else 'err' }}">
                            {{ config.agentIds | length }} 个
                        </span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">工作时间</span>
                        <span class="status-value">{{ config.workStart }} - {{ config.workEnd }}</span>
                    </div>
                </div>
                
                <div class="form-group">
                    <label>🔗 分享链接</label>
                    {% if config.shareUrl %}
                    <div class="current-value">
                        <div class="current-value-label">当前链接</div>
                        {{ config.shareUrl }}
                    </div>
                    {% endif %}
                    <div class="paste-box" onclick="document.getElementById('shareUrl').focus()">
                        <textarea id="shareUrl-paste" rows="2" placeholder="📋 粘贴分享链接（可带前缀，自动提取URL）
如：分享链接：https://admin.scrmceo.com/s/xxxxx" oninput="autoExtractUrl()"></textarea>
                    </div>
                    <input type="hidden" name="shareUrl" id="shareUrl" value="{{ config.shareUrl }}">
                    <div class="help-text">
                        💡 支持直接粘贴带文字的链接，自动提取 URL。格式如 <code>https://admin.scrmceo.com/s/xxx?code=xxx</code>
                    </div>
                    <div id="url-parse-result" class="parse-result"></div>
                </div>
                
                <div class="form-group">
                    <label>🔑 分享密码</label>
                    <input type="text" name="password" id="password" value="{{ config.password }}" placeholder="输入分享密码（如无需则留空）">
                </div>
                
                <div class="form-group">
                    <label>👤 监控客服号 <span style="font-weight:normal;color:#909399;font-size:12px;">（{{ config.agentIds | length }} 个）</span></label>
                    {% if config.agentIds %}
                    <div class="agent-tags" id="agent-tags">
                        {% for aid in config.agentIds %}
                        <span class="agent-tag">
                            {{ aid }}
                            <span class="remove" onclick="removeAgent('{{ aid }}')">×</span>
                        </span>
                        {% endfor %}
                    </div>
                    {% endif %}
                    <div class="quick-actions">
                        <button type="button" class="quick-btn" onclick="extractFromLinks()">从链接提取</button>
                        <button type="button" class="quick-btn" onclick="addAgentPrompt()">手动添加</button>
                        <button type="button" class="quick-btn" onclick="clearAllAgents()">清空全部</button>
                    </div>
                    <input type="text" id="agent-input" placeholder="输入客服号，按回车添加，如 @user123" onkeypress="handleAgentInput(event)">
                    <input type="hidden" name="agentIds" id="agentIds-hidden" value="{{ config.agentIds | join(',') }}">
                    <div class="help-text">
                        💡 支持 <code>@用户名</code> 或 <code>ti/p/xxx</code> 链接格式，自动提取客服号
                    </div>
                </div>
                
                <div class="btn-group">
                    <button type="submit" class="btn btn-primary">💾 保存配置</button>
                    <button type="button" class="btn btn-secondary" onclick="location.href='/'">🔄 刷新</button>
                </div>
            </div>
            
            <!-- 参数设置 -->
            <div id="tab-settings" class="tab-content">
                <div class="form-group">
                    <label>⏰ 工作时间</label>
                    <div style="display: flex; gap: 12px; align-items: center;">
                        <input type="time" name="workStart" value="{{ config.workStart }}" style="flex: 1;">
                        <span style="color:#909399;">至</span>
                        <input type="time" name="workEnd" value="{{ config.workEnd }}" style="flex: 1;">
                    </div>
                    <div class="help-text">爬虫工作时间段（北京时间），非工作时段不爬取</div>
                </div>
                
                <div class="form-group">
                    <label>📱 PushPlus Token</label>
                    {% if config.pushplusToken %}
                    <div class="current-value">
                        <div class="current-value-label">当前 Token</div>
                        {{ config.pushplusToken[:10] }}...{{ config.pushplusToken[-10:] }}
                    </div>
                    {% endif %}
                    <input type="text" name="pushplusToken" value="{{ config.pushplusToken }}" placeholder="输入PushPlus Token用于告警通知">
                    <div class="help-text">用于 SCRM 登录失效等告警推送</div>
                </div>
                
                <div class="form-group">
                    <label>🔐 Cookie 导入 Token</label>
                    <input type="text" name="cookieImportToken" value="{{ config.get('cookieImportToken', '') }}" placeholder="留空则内网不鉴权">
                    <div class="help-text">Chrome 扩展同步 Cookie 时的鉴权 token，内网可留空</div>
                </div>
                
                <div class="form-group">
                    <label>🌐 配置同步 API</label>
                    <input type="text" name="configApiUrl" value="{{ config.get('configApiUrl', '') }}" placeholder="http://192.168.0.100:3211/api/config">
                    <div class="help-text">Windows 爬虫从该地址拉取 NAS 配置，保持两边同步</div>
                </div>
                
                <div class="form-group">
                    <label>📝 备注</label>
                    <textarea name="note" placeholder="输入备注信息">{{ config.note }}</textarea>
                </div>
                
                <div class="btn-group">
                    <button type="submit" class="btn btn-primary">💾 保存设置</button>
                    <button type="button" class="btn btn-secondary" onclick="location.href='/'">🔄 刷新</button>
                </div>
            </div>
            
            <!-- Cookie -->
            <div id="tab-cookie" class="tab-content">
                <div class="cookie-section">
                    <h4>🍪 Cookie 同步说明</h4>
                    <p>
                        SCRM 常被 Cloudflare 拦截，需要 <code>cf_clearance</code> Cookie 才能正常抓取。<br>
                        使用 Chrome 扩展「SCRM Cookie Sync」一键同步到本机/NAS。
                    </p>
                </div>
                
                <div class="status-card">
                    <div class="status-row">
                        <span class="status-label">Cookie 状态</span>
                        <span class="status-value" id="cookie-status">加载中...</span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">Cookie 数量</span>
                        <span class="status-value" id="cookie-count">-</span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">导入时间</span>
                        <span class="status-value" id="cookie-time">-</span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">含 cf_clearance</span>
                        <span class="status-value" id="cookie-cf">-</span>
                    </div>
                    <div class="status-row">
                        <span class="status-label">来源</span>
                        <span class="status-value" id="cookie-source">-</span>
                    </div>
                </div>
                
                <div class="form-group">
                    <label>📥 手动导入 Cookie</label>
                    <textarea id="manual-cookies" rows="4" placeholder="粘贴 JSON 格式的 Cookie 数组，或从浏览器 DevTools 复制"></textarea>
                    <div class="help-text">
                        支持格式：Chrome 扩展导出格式、Playwright 格式、或简单的 name=value 每行一个
                    </div>
                </div>
                
                <div class="btn-group">
                    <button type="button" class="btn btn-success" onclick="importManualCookies()">📥 导入 Cookie</button>
                    <button type="button" class="btn btn-secondary" onclick="refreshCookieStatus()">🔄 刷新状态</button>
                </div>
                
                <div id="cookie-import-result" class="parse-result" style="margin-top:12px;"></div>
            </div>
        </form>
        
        <div class="footer">
            <p>配置文件: {{ config_file }}</p>
            <p>爬虫周期: 工作时段内每 10-15 分钟一轮</p>
        </div>
    </div>

<script>
// ========== Tab 切换 ==========
function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('tab-' + name).classList.add('active');
    if (name === 'cookie') refreshCookieStatus();
    if (name === 'monitor') loadMonitorData();
}

// ========== 监控数据 ==========
let _monitorCache = null;

async function loadMonitorData() {
    const statusEl = document.getElementById('mon-scrape-status');
    const timeEl = document.getElementById('mon-last-time');
    const countEl = document.getElementById('mon-agent-count');
    const cookieEl = document.getElementById('mon-cookie-status');
    const onlineEl = document.getElementById('mon-online');
    const totalEl = document.getElementById('mon-total');
    const todayEl = document.getElementById('mon-today-leads');
    const totalLeadsEl = document.getElementById('mon-total-leads');
    const listEl = document.getElementById('mon-agents-list');
    
    statusEl.textContent = '加载中...';
    statusEl.className = 'status-value';
    
    try {
        const r = await fetch('/api/snapshot', { cache: 'no-cache' });
        const data = await r.json();
        
        if (!data.ok || !data.snapshot) {
            statusEl.textContent = '暂无数据';
            statusEl.className = 'status-value warn';
            timeEl.textContent = data.mtime || '-';
            listEl.innerHTML = '<div style="text-align:center;color:#909399;padding:20px;font-size:13px;">还没有抓取数据<br>请等待下一轮抓取（约 10-15 分钟）</div>';
            return;
        }
        
        const snap = data.snapshot;
        const agents = snap.agents || {};
        const summary = snap.summary || {};
        const notFound = snap.notFound || [];
        const inherited = snap.inherited || [];
        
        // 状态
        const agentCount = Object.keys(agents).length + notFound.length;
        statusEl.textContent = agentCount > 0 ? '✅ 正常' : '⚠️ 无数据';
        statusEl.className = 'status-value ' + (agentCount > 0 ? 'ok' : 'warn');
        countEl.textContent = agentCount + ' 个';
        timeEl.textContent = data.mtime || '-';
        
        // 汇总
        onlineEl.textContent = summary.onlineAppCount ?? '-';
        totalEl.textContent = summary.totalAppCount ?? '-';
        todayEl.textContent = summary.todayLeads ?? '-';
        totalLeadsEl.textContent = summary.totalLeads ?? '-';
        
        // Cookie 状态（从 header 或单独请求）
        try {
            const cr = await fetch('/api/cookies/status', { cache: 'no-cache' });
            const cd = await cr.json();
            if (cd.ok && cd.hasCookies) {
                cookieEl.textContent = cd.hasCfClearance ? '✅ 正常' : '⚠️ 缺 cf_clearance';
                cookieEl.className = 'status-value ' + (cd.hasCfClearance ? 'ok' : 'warn');
            } else {
                cookieEl.textContent = '❌ 无';
                cookieEl.className = 'status-value err';
            }
        } catch (_) {
            cookieEl.textContent = '-';
        }
        
        // 客服列表
        const agentEntries = Object.entries(agents);
        if (agentEntries.length === 0 && notFound.length === 0) {
            listEl.innerHTML = '<div style="text-align:center;color:#909399;padding:30px;font-size:13px;">暂无客服数据</div>';
            return;
        }
        
        // 存到全局供筛选使用
        window._agentData = { agents, notFound };
        
        renderAgentCards('all');
        
    } catch (e) {
        statusEl.textContent = '❌ 加载失败';
        statusEl.className = 'status-value err';
        listEl.innerHTML = '<div style="text-align:center;color:#f56c6c;padding:20px;font-size:13px;">加载失败: ' + e.message + '</div>';
    }
}

// ========== 客服筛选 & 渲染 ==========
function filterAgents(type, btn) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderAgentCards(type);
}

function renderAgentCards(filterType) {
    const listEl = document.getElementById('mon-agents-list');
    if (!window._agentData) return;
    
    const { agents, notFound } = window._agentData;
    const agentEntries = Object.entries(agents);
    let html = '';
    let count = 0;
    
    // 排序：在线 > 离线 > 继承 > 未找到
    const sorted = agentEntries.sort((a, b) => {
        const rank = (info) => {
            if (info.inherited) return 2;
            if (info.online || info.status === 'online') return 0;
            return 1;
        };
        return rank(a[1]) - rank(b[1]);
    });
    
    // 已找到的客服
    for (const [id, info] of sorted) {
        const isInherited = info.inherited;
        const isOnline = info.online || info.status === 'online';
        let statusClass, statusText;
        
        if (isInherited) {
            statusClass = 'inherited';
            statusText = '继承数据';
        } else if (isOnline) {
            statusClass = 'online';
            statusText = info.statusText || '在线';
        } else {
            statusClass = 'offline';
            statusText = info.statusText || '离线';
        }
        
        // 筛选
        if (filterType !== 'all') {
            if (filterType === 'online' && !isOnline) continue;
            if (filterType === 'offline' && (isOnline || isInherited)) continue;
            if (filterType === 'inherited' && !isInherited) continue;
        }
        
        count++;
        
        const todayDone = info.todayDone ?? 0;
        const todayTarget = info.todayTarget ?? 0;
        const percent = todayTarget > 0 ? Math.min(100, Math.round(todayDone / todayTarget * 100)) : 0;
        const isDone = todayTarget > 0 && todayDone >= todayTarget;
        const nickname = info.nickname || '';
        const remark = info.remark || '';
        const lastActive = info.lastActive || '';
        
        html += `
            <div class="agent-card ${statusClass}">
                <div class="agent-card-header">
                    <div class="agent-card-name">
                        ${escapeHtml(id)}
                    </div>
                    <span class="agent-card-status ${statusClass}">${escapeHtml(statusText)}</span>
                </div>
                ${nickname ? `<div class="agent-card-nickname">💬 ${escapeHtml(nickname)}</div>` : ''}
                <div class="agent-card-progress">
                    <div class="progress-label">
                        <span>今日进度</span>
                        <span><b>${todayDone}</b> / ${todayTarget} （${percent}%）</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill ${isDone ? 'done' : ''}" style="width:${percent}%"></div>
                    </div>
                </div>
                <div class="agent-card-meta">
                    <span title="${escapeHtml(remark)}">📝 ${escapeHtml(remark || '无备注')}</span>
                    ${lastActive ? `<span>🕐 ${escapeHtml(lastActive)}</span>` : ''}
                </div>
            </div>
        `;
    }
    
    // 未找到的客服
    if (filterType === 'all' || filterType === 'notfound') {
        for (const id of notFound) {
            count++;
            html += `
                <div class="agent-card notfound">
                    <div class="agent-card-header">
                        <div class="agent-card-name">
                            ${escapeHtml(id)}
                        </div>
                        <span class="agent-card-status notfound">未找到</span>
                    </div>
                    <div class="agent-card-nickname" style="color:#f56c6c;">
                        ⚠️ 在分享链接中未搜索到此客服号
                    </div>
                    <div class="agent-card-meta">
                        <span>可能原因：用户名错误 / 账号已注销 / 搜索结果未展示</span>
                    </div>
                </div>
            `;
        }
    }
    
    if (count === 0) {
        html = '<div style="text-align:center;color:#909399;padding:30px;font-size:13px;">该分类下暂无数据</div>';
    }
    
    listEl.innerHTML = html;
}

// ========== 分享链接自动提取 ==========
function autoExtractUrl() {
    const pasteBox = document.getElementById('shareUrl-paste');
    const hiddenInput = document.getElementById('shareUrl');
    const resultDiv = document.getElementById('url-parse-result');
    const raw = pasteBox.value;
    
    if (!raw.trim()) {
        resultDiv.classList.remove('show');
        return;
    }
    
    // 提取 URL
    const match = raw.match(/https?:\/\/[^\s"'<>\uff0c\u3002\uff1b;\uff09)\u300f\u300d]+/i);
    if (match) {
        const url = match[0].replace(/[，。；;）)』」'"]+$/g, '');
        hiddenInput.value = url;
        resultDiv.textContent = '✅ 已提取链接: ' + url.substring(0, 80) + (url.length > 80 ? '...' : '');
        resultDiv.className = 'parse-result show';
    } else if (raw.trim()) {
        hiddenInput.value = raw.trim();
        resultDiv.textContent = '⚠️ 未检测到标准 URL，已保留原始内容';
        resultDiv.className = 'parse-result show parse-result-error';
    }
}

// 初始化：如果已有链接，显示到粘贴框
document.addEventListener('DOMContentLoaded', function() {
    const shareUrl = document.getElementById('shareUrl').value;
    if (shareUrl) {
        document.getElementById('shareUrl-paste').value = shareUrl;
    }
    refreshAgentTags();
    // 加载监控数据（默认显示监控Tab）
    loadMonitorData();
});

// ========== 客服号管理 ==========
function getAgentIds() {
    const hidden = document.getElementById('agentIds-hidden').value;
    return hidden ? hidden.split(',').filter(Boolean) : [];
}

function setAgentIds(ids) {
    document.getElementById('agentIds-hidden').value = ids.join(',');
    refreshAgentTags();
}

function refreshAgentTags() {
    const ids = getAgentIds();
    const container = document.getElementById('agent-tags');
    if (!ids.length) {
        if (container) container.innerHTML = '';
        return;
    }
    const html = ids.map(id => 
        `<span class="agent-tag">${escapeHtml(id)} <span class="remove" onclick="removeAgent('${escapeHtml(id)}')">×</span></span>`
    ).join('');
    if (container) container.innerHTML = html;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function handleAgentInput(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        const input = document.getElementById('agent-input');
        const val = input.value.trim();
        if (val) {
            addAgent(val);
            input.value = '';
        }
    }
}

function addAgent(raw) {
    const ids = getAgentIds();
    let id = raw.trim();
    
    // 从 ti/p/xxx 链接提取
    const tipMatch = id.match(/ti\/p\/([^\s/?#]+)/i);
    if (tipMatch) id = tipMatch[1];
    
    // 确保带 @
    if (id && !id.startsWith('@')) id = '@' + id;
    
    if (id && !ids.includes(id)) {
        ids.push(id);
        setAgentIds(ids);
    }
}

function removeAgent(id) {
    const ids = getAgentIds().filter(a => a !== id);
    setAgentIds(ids);
}

function addAgentPrompt() {
    const id = prompt('请输入客服号（如 @user123）：');
    if (id) addAgent(id);
}

function clearAllAgents() {
    if (confirm('确定清空所有监控客服号？')) {
        setAgentIds([]);
    }
}

function extractFromLinks() {
    const urlText = document.getElementById('shareUrl-paste').value || '';
    const password = document.getElementById('password').value || '';
    // 从分享链接里提取客服号不太现实，改为提示用户
    alert('提示：请在下方输入框手动添加客服号，或从推广链接页面同步。\n\n客服号格式：@用户名');
    document.getElementById('agent-input').focus();
}

// ========== Cookie 状态 ==========
async function refreshCookieStatus() {
    const statusEl = document.getElementById('cookie-status');
    const countEl = document.getElementById('cookie-count');
    const timeEl = document.getElementById('cookie-time');
    const cfEl = document.getElementById('cookie-cf');
    const sourceEl = document.getElementById('cookie-source');
    
    statusEl.textContent = '加载中...';
    statusEl.className = 'status-value';
    
    try {
        const r = await fetch('/api/cookies/status');
        const data = await r.json();
        if (data.ok && data.hasCookies) {
            statusEl.textContent = '✅ 正常';
            statusEl.className = 'status-value ok';
            countEl.textContent = data.count + ' 条';
            timeEl.textContent = data.imported_at || '-';
            sourceEl.textContent = data.source || '-';
            
            // 检查是否有 cf_clearance
            const domains = data.domains || [];
            // 从 domains 无法直接判断，从 count 推测
            cfEl.textContent = '请用扩展同步后查看';
            cfEl.className = 'status-value warn';
        } else {
            statusEl.textContent = '❌ 无 Cookie';
            statusEl.className = 'status-value err';
            countEl.textContent = '0 条';
            timeEl.textContent = '-';
            cfEl.textContent = '❌ 无';
            cfEl.className = 'status-value err';
            sourceEl.textContent = '-';
        }
    } catch (e) {
        statusEl.textContent = '❌ 查询失败';
        statusEl.className = 'status-value err';
    }
}

async function importManualCookies() {
    const textarea = document.getElementById('manual-cookies');
    const resultDiv = document.getElementById('cookie-import-result');
    const raw = textarea.value.trim();
    
    if (!raw) {
        resultDiv.textContent = '请输入 Cookie 内容';
        resultDiv.className = 'parse-result show parse-result-error';
        return;
    }
    
    let cookies = [];
    
    // 尝试解析 JSON
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            cookies = parsed;
        } else if (parsed.cookies && Array.isArray(parsed.cookies)) {
            cookies = parsed.cookies;
        }
    } catch (_) {
        // 解析 name=value; name2=value2 格式
        // 注意：cf_clearance 等值本身包含分号，不能简单按 ; 分割
        cookies = parseCookieString(raw);
    }
    
    /**
     * 智能解析 Cookie 字符串
     * 策略：先找出所有 cookie 名的位置，然后按位置切片
     */
    function parseCookieString(str) {
        // 去掉 "Cookie:" 前缀
        let s = str.replace(/^Cookie:\s*/i, '').trim();
        
        // 常见的 SCRM/Cloudflare cookie 名（用于辅助定位分割点）
        const knownNames = [
            'cf_clearance', '_gcl_au', '_ga', '_gid', '_gat',
            'session', 'token', 'auth', 'login', 'user',
            'PHPSESSID', 'JSESSIONID', 'csrftoken',
            'scc', '__cf_bm', 'cf_chl',
            '__Secure-', '__Host-',
            'NID', 'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
        ];
        
        const results = [];
        
        // 策略1：按 "name=" 模式匹配，利用已知 cookie 名辅助
        // 找所有形如 "word=" 的位置，且前面是行首或 ; 或空格
        const pattern = /(?:^|[\s;；])([A-Za-z_][A-Za-z0-9_.-]*)=/g;
        const positions = [];
        let m;
        while ((m = pattern.exec(s)) !== null) {
            const name = m[1];
            // 排除明显不是 cookie 名的（如 path=, domain=, expires= 等出现在 value 里的）
            const skipList = ['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'version', 'comment'];
            if (skipList.includes(name.toLowerCase())) continue;
            positions.push({ name, start: m.index + m[0].length - name.length - 1 }); // 回到 name 前的分隔符
        }
        
        if (positions.length === 0) return [];
        
        // 按位置排序
        positions.sort((a, b) => a.start - b.start);
        
        for (let i = 0; i < positions.length; i++) {
            const pos = positions[i];
            const nameStart = s.indexOf(pos.name + '=', pos.start);
            if (nameStart < 0) continue;
            const valueStart = nameStart + pos.name.length + 1;
            
            // 值的结束位置：下一个 cookie 的开始，或字符串末尾
            let valueEnd = s.length;
            if (i + 1 < positions.length) {
                // 找下一个 cookie 名前的 ;
                const nextStart = positions[i + 1].start;
                // 从 valueStart 到 nextStart 之间往回找 ;
                for (let j = nextStart; j > valueStart; j--) {
                    if (s[j] === ';' || s[j] === '；') {
                        valueEnd = j;
                        break;
                    }
                }
                // 如果没找到分号，就用下一个位置
                if (valueEnd === s.length) {
                    valueEnd = nextStart;
                }
            }
            
            const name = pos.name;
            const value = s.substring(valueStart, valueEnd).trim().replace(/[;；\s]+$/, '');
            
            if (name && value) {
                results.push({
                    name: name,
                    value: value,
                    domain: name === 'cf_clearance' ? '.scrmceo.com' : 'admin.scrmceo.com',
                    path: '/'
                });
            }
        }
        
        return results;
    }
    
    if (!cookies.length) {
        resultDiv.textContent = '❌ 无法解析 Cookie 格式';
        resultDiv.className = 'parse-result show parse-result-error';
        return;
    }
    
    try {
        const r = await fetch('/api/cookies/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'manual-web', cookies: cookies })
        });
        const data = await r.json();
        if (data.ok) {
            resultDiv.textContent = '✅ 导入成功！共 ' + data.count + ' 条 Cookie';
            resultDiv.className = 'parse-result show';
            textarea.value = '';
            refreshCookieStatus();
        } else {
            resultDiv.textContent = '❌ 导入失败: ' + (data.error || 'unknown');
            resultDiv.className = 'parse-result show parse-result-error';
        }
    } catch (e) {
        resultDiv.textContent = '❌ 请求失败: ' + e.message;
        resultDiv.className = 'parse-result show parse-result-error';
    }
}
</script>
</body>
</html>
"""

def load_config():
    """加载配置文件"""
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        # 自动洗掉「分享链接：」等粘贴前缀，避免 Playwright Cannot navigate
        cleaned = sanitize_share_url(cfg.get("shareUrl") or "")
        if cleaned and cleaned != cfg.get("shareUrl"):
            cfg["shareUrl"] = cleaned
            try:
                save_config(cfg)
            except Exception:
                pass
        # 确保默认字段存在
        cfg.setdefault("shareUrl", "")
        cfg.setdefault("password", "")
        cfg.setdefault("pushplusToken", "")
        cfg.setdefault("zeroTime", "08:00:00")
        cfg.setdefault("workStart", "08:00")
        cfg.setdefault("workEnd", "19:00")
        cfg.setdefault("agentIds", [])
        cfg.setdefault("note", "")
        cfg.setdefault("cookieImportToken", "")
        cfg.setdefault("configApiUrl", "")
        return cfg
    except Exception as e:
        print(f"Error loading config: {e}")
        return {
            "shareUrl": "",
            "password": "",
            "pushplusToken": "",
            "zeroTime": "08:00:00",
            "workStart": "08:00",
            "workEnd": "19:00",
            "agentIds": [],
            "note": "",
            "cookieImportToken": "",
            "configApiUrl": "",
        }

def sanitize_share_url(raw):
    """从粘贴文本中抽出真正的 http(s) URL（去掉「分享链接：」等前缀）。"""
    s = str(raw or "").strip()
    if not s:
        return ""
    if s.startswith("http://") or s.startswith("https://"):
        return s
    m = re.search(r"https?://[^\s\"'<>]+", s)
    if not m:
        return s
    return m.group(0).rstrip("，。；;）)』」\"'")

def save_config(config):
    """保存配置文件"""
    try:
        if isinstance(config, dict) and "shareUrl" in config:
            config["shareUrl"] = sanitize_share_url(config.get("shareUrl") or "")
        # 确保 agentIds 是列表
        if isinstance(config.get("agentIds"), str):
            config["agentIds"] = [a.strip() for a in config["agentIds"].split(",") if a.strip()]
        os.makedirs(os.path.dirname(CONFIG_FILE) or ".", exist_ok=True)
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"Error saving config: {e}")
        return False

@app.route('/')
def index():
    """主页"""
    config = load_config()
    return render_template_string(HTML_TEMPLATE, config=config, config_file=CONFIG_FILE)

@app.route('/save', methods=['POST'])
def save():
    """保存配置"""
    config = load_config()
    
    # 更新配置
    config['shareUrl'] = request.form.get('shareUrl', config.get('shareUrl', ''))
    config['password'] = request.form.get('password', config.get('password', ''))
    config['workStart'] = request.form.get('workStart', config.get('workStart', '08:00'))
    config['workEnd'] = request.form.get('workEnd', config.get('workEnd', '19:00'))
    config['pushplusToken'] = request.form.get('pushplusToken', config.get('pushplusToken', ''))
    config['note'] = request.form.get('note', config.get('note', ''))
    config['cookieImportToken'] = request.form.get('cookieImportToken', config.get('cookieImportToken', ''))
    config['configApiUrl'] = request.form.get('configApiUrl', config.get('configApiUrl', ''))
    
    # 处理客服号（逗号分隔）
    agent_ids_str = request.form.get('agentIds', '')
    if agent_ids_str:
        # 分割并清理空格，确保带@
        agent_ids = []
        for aid in agent_ids_str.split(','):
            aid = aid.strip()
            if aid:
                if not aid.startswith('@'):
                    aid = '@' + aid
                agent_ids.append(aid)
        config['agentIds'] = agent_ids
    else:
        config['agentIds'] = []
    
    if save_config(config):
        flash('配置已保存！', 'success')
    else:
        flash('保存失败，请检查文件权限。', 'error')
    
    return redirect(url_for('index'))

@app.route('/api/config')
def api_config():
    """API: 获取配置"""
    return jsonify(load_config())

@app.route('/api/config', methods=['POST'])
def api_config_post():
    """API: 更新配置"""
    try:
        new_config = request.json
        if save_config(new_config):
            return jsonify({"success": True, "message": "配置已更新"})
        else:
            return jsonify({"success": False, "message": "保存失败"}), 500
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 400


@app.route('/api/snapshot')
def api_snapshot():
    """API: 获取最近一次抓取快照"""
    import json as _json
    
    # 尝试多个可能的路径
    candidate_paths = []
    
    # 1. 配置文件同级
    config_dir = os.path.dirname(CONFIG_FILE) or "."
    candidate_paths.append(os.path.join(config_dir, "last-snapshot.json"))
    
    # 2. 配置目录的 data 子目录
    candidate_paths.append(os.path.join(config_dir, "data", "last-snapshot.json"))
    
    # 3. 工作目录
    candidate_paths.append(os.path.join(os.getcwd(), "last-snapshot.json"))
    candidate_paths.append(os.path.join(os.getcwd(), "data", "last-snapshot.json"))
    
    # 4. 常见路径
    candidate_paths.append("/app/last-snapshot.json")
    candidate_paths.append("/app/data/last-snapshot.json")
    candidate_paths.append("/data/last-snapshot.json")
    
    snapshot_path = None
    for p in candidate_paths:
        if os.path.exists(p):
            snapshot_path = p
            break
    
    if not snapshot_path:
        return jsonify({
            "ok": True,
            "snapshot": None,
            "mtime": None,
            "candidates": candidate_paths,
            "message": "no snapshot yet"
        })
    
    try:
        mtime = os.path.getmtime(snapshot_path)
        with open(snapshot_path, 'r', encoding='utf-8') as f:
            snap = _json.load(f)
        
        # 格式化时间（东八区）
        from datetime import datetime, timedelta
        mtime_utc = datetime.utcfromtimestamp(mtime)
        mtime_cst = mtime_utc + timedelta(hours=8)
        mtime_str = mtime_cst.strftime('%Y-%m-%d %H:%M:%S')
        
        return jsonify({
            "ok": True,
            "snapshot": snap,
            "mtime": mtime_str,
            "mtime_epoch": mtime,
            "path": snapshot_path
        })
    except Exception as e:
        return jsonify({
            "ok": False,
            "error": str(e),
            "path": snapshot_path
        }), 500


def _cookie_token_ok(body_token=None, source=None):
    # 网页端手动导入：同源请求直接放行（能访问管理页面就是可信的）
    if source and source == "manual-web":
        return True
    cfg = load_config()
    expected = (
        cfg.get("cookieImportToken")
        or cfg.get("opsStatusToken")
        or os.environ.get("COOKIE_IMPORT_TOKEN")
        or ""
    )
    expected = str(expected).strip()
    if not expected:
        # 内网默认放行；若配置了 token 则必须匹配
        return True
    got = (body_token or request.headers.get("X-Cookie-Token") or "").strip()
    return got == expected


@app.after_request
def _cors_cookies(resp):
    """允许 Chrome 扩展从 popup 跨域导入 cookie。"""
    origin = request.headers.get("Origin") or "*"
    if request.path.startswith("/api/cookies"):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Cookie-Token"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Vary"] = "Origin"
    return resp


@app.route("/api/cookies/import", methods=["OPTIONS"])
@app.route("/api/cookies/status", methods=["OPTIONS"])
def api_cookies_options():
    return ("", 204)


@app.route("/api/cookies/import", methods=["POST"])
def api_cookies_import():
    """本机扩展一键推送 admin.scrmceo.com 登录 cookie。"""
    try:
        from cookie_store import save_cookies

        body = request.get_json(force=True, silent=True) or {}
        if not _cookie_token_ok(body.get("token"), body.get("source")):
            return jsonify({"ok": False, "error": "unauthorized"}), 401
        cookies = body.get("cookies") or []
        if not isinstance(cookies, list) or len(cookies) == 0:
            return jsonify({"ok": False, "error": "cookies required"}), 400
        meta = save_cookies(cookies, source=str(body.get("source") or "api"))
        return jsonify({"ok": True, **meta})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/cookies/status", methods=["GET"])
def api_cookies_status():
    try:
        from cookie_store import read_meta, cookie_path, cookie_file_mtime, load_playwright_cookies, has_cf_clearance

        meta = read_meta()
        cookies = load_playwright_cookies()
        return jsonify(
            {
                "ok": True,
                "hasCookies": bool(meta.get("count")),
                "path": cookie_path(),
                "mtime": cookie_file_mtime() or None,
                "hasCfClearance": has_cf_clearance(cookies),
                **meta,
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == '__main__':
    host = os.environ.get('FLASK_HOST', '0.0.0.0')
    port = int(os.environ.get('FLASK_PORT', '3211'))
    print("=" * 50)
    print("🌐 SCRM Scraper 管理界面 v2")
    print("=" * 50)
    print(f"配置文件: {CONFIG_FILE}")
    print(f"访问地址: http://{host}:{port}")
    print("=" * 50)
    app.run(host=host, port=port, debug=False)
