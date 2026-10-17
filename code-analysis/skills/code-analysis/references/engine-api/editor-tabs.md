---
grounded: 2026-08-05
---

# Engine API — embedded web views

## SWebBrowser

`Source/Runtime/WebBrowser/Public/SWebBrowser.h:21`. Module `WebBrowser` is a plain engine runtime module (CEF3-backed, `bRequiresPlatformSDK = true`), so using it needs no `.uproject` change. `SWebBrowser` does not load the module itself: call `IWebBrowserModule::Get()` before constructing the widget, or the throbber spins forever with no browser behind it.
