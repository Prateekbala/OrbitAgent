import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
const origin = String(Constants.expoConfig?.extra?.origin ?? '');
function permitted(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
export default function App() {
  const web = useRef<WebView<object>>(null),
    [failed, setFailed] = useState(false),
    [loading, setLoading] = useState(true),
    [canGoBack, setCanGoBack] = useState(false),
    dark = useColorScheme() === 'dark';
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack) return false;
      web.current?.goBack();
      return true;
    });
    return () => listener.remove();
  }, [canGoBack]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && failed) {
        setFailed(false);
        web.current?.reload();
      }
    });
    return () => listener.remove();
  }, [failed]);
  const backgroundColor = dark ? '#18181b' : '#ffffff',
    color = dark ? '#fafafa' : '#18181b';
  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.root, { backgroundColor }]}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        {!permitted(origin) ? (
          <Text style={[styles.message, { color }]} accessibilityRole="alert">
            Configure the trusted workspace address before building this client.
          </Text>
        ) : (
          <>
            <WebView<object>
              ref={web}
              source={{ uri: origin + '/app' }}
              originWhitelist={[origin]}
              incognito
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              cacheEnabled={false}
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              mixedContentMode="never"
              javaScriptCanOpenWindowsAutomatically={false}
              setSupportMultipleWindows
              onShouldStartLoadWithRequest={(request) => {
                if (permitted(request.url)) return true;
                try {
                  const url = new URL(request.url);
                  if (
                    request.isTopFrame &&
                    url.protocol === 'https:' &&
                    !url.username &&
                    !url.password
                  )
                    void Linking.openURL(url.href);
                } catch {}
                return false;
              }}
              onOpenWindow={(event) => {
                try {
                  const url = new URL(event.nativeEvent.targetUrl);
                  if (url.protocol === 'https:' && !url.username && !url.password)
                    void Linking.openURL(url.href);
                } catch {}
              }}
              onNavigationStateChange={(state) => setCanGoBack(state.canGoBack)}
              onLoadStart={() => setLoading(true)}
              onLoadEnd={() => setLoading(false)}
              onError={() => {
                setFailed(true);
                setLoading(false);
              }}
              onHttpError={(event) => {
                if (event.nativeEvent.statusCode >= 500) {
                  setFailed(true);
                  setLoading(false);
                }
              }}
              onContentProcessDidTerminate={() => {
                setFailed(true);
                setLoading(false);
              }}
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction
              mediaCapturePermissionGrantType="prompt"
              webviewDebuggingEnabled={__DEV__}
              style={{ backgroundColor }}
            />

            {failed && (
              <View style={[styles.failure, { backgroundColor }]}>
                <Text accessibilityRole="header" style={[styles.heading, { color }]}>
                  Your workspace is unavailable
                </Text>
                <Text style={[styles.message, { color }]}>
                  Reconnect to open Orbit. Your current private session stays open while you retry.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  style={styles.button}
                  onPress={() => {
                    setFailed(false);
                    setLoading(true);
                    web.current?.reload();
                  }}
                >
                  <Text>Try again</Text>
                </Pressable>
              </View>
            )}
            {loading && !failed && (
              <View
                style={styles.loading}
                accessibilityRole="progressbar"
                accessibilityLabel="Opening your workspace"
              >
                <ActivityIndicator size="large" color="#b28a15" />
              </View>
            )}
          </>
        )}
        <Text style={[styles.session, { color }]}>
          {Platform.OS === 'ios' ? 'iOS' : 'Android'} · Private session
        </Text>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  failure: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 16,
  },
  heading: { fontSize: 24, fontWeight: '700' },
  message: { fontSize: 16, lineHeight: 24, textAlign: 'center', padding: 16 },
  button: {
    backgroundColor: '#F8CB46',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  loading: { position: 'absolute', top: '45%', alignSelf: 'center' },
  session: { textAlign: 'center', fontSize: 11, padding: 4 },
});
