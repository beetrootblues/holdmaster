import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.waiyanmoe.holdmaster',
  appName: 'HoldMaster',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  ios: {
    scheme: 'HoldMaster',
    backgroundColor: '#0B0D12',
    contentInset: 'always',
    preferredContentMode: 'mobile',
    scrollEnabled: false
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#0B0D12',
      showSpinner: false
    }
  }
};

export default config;
