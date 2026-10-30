# Mobile Developer — Worked Examples

Externalized from the agent definition per the few-shot-examples rule (#1587).

## Process Sample Blocks

These full sample implementations back the capability summaries in the agent's "## Your Process" section. Each illustrates the architecture, pattern, or pipeline the agent produces.

### 1. Architecture Design

**iOS — Clean Architecture with SwiftUI**

```swift
// MARK: - Domain Layer
protocol UserRepository {
    func fetchUser(id: String) async throws -> User
    func updateProfile(_ profile: UserProfile) async throws
}

struct FetchUserUseCase {
    private let repository: UserRepository

    init(repository: UserRepository) {
        self.repository = repository
    }

    func execute(id: String) async throws -> User {
        try await repository.fetchUser(id: id)
    }
}

// MARK: - ViewModel
@MainActor
final class ProfileViewModel: ObservableObject {
    @Published private(set) var state: ViewState<User> = .idle

    private let fetchUser: FetchUserUseCase

    init(fetchUser: FetchUserUseCase) {
        self.fetchUser = fetchUser
    }

    func load(id: String) async {
        state = .loading
        do {
            let user = try await fetchUser.execute(id: id)
            state = .loaded(user)
        } catch {
            state = .error(error.localizedDescription)
        }
    }
}

// MARK: - View
struct ProfileView: View {
    @StateObject private var viewModel: ProfileViewModel

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading:
                ProgressView()
            case .loaded(let user):
                UserDetailView(user: user)
            case .error(let message):
                ErrorView(message: message)
            }
        }
        .task { await viewModel.load(id: userId) }
    }
}
```

**Android — MVVM with Jetpack Compose**

```kotlin
// ViewModel with StateFlow
@HiltViewModel
class ProfileViewModel @Inject constructor(
    private val getUserUseCase: GetUserUseCase,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val userId: String = checkNotNull(savedStateHandle["userId"])

    private val _uiState = MutableStateFlow<UiState<User>>(UiState.Loading)
    val uiState: StateFlow<UiState<User>> = _uiState.asStateFlow()

    init { loadUser() }

    private fun loadUser() {
        viewModelScope.launch {
            getUserUseCase(userId)
                .onSuccess { _uiState.value = UiState.Success(it) }
                .onFailure { _uiState.value = UiState.Error(it.message ?: "Unknown error") }
        }
    }
}

// Composable screen
@Composable
fun ProfileScreen(viewModel: ProfileViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    Scaffold { padding ->
        when (val state = uiState) {
            is UiState.Loading -> CircularProgressIndicator(
                modifier = Modifier.align(Alignment.Center)
            )
            is UiState.Success -> UserDetail(
                user = state.data,
                modifier = Modifier.padding(padding)
            )
            is UiState.Error -> ErrorMessage(
                message = state.message,
                onRetry = viewModel::loadUser
            )
        }
    }
}
```

### 2. React Native Components and Native Bridge

**Shared component with platform-specific behavior**

```tsx
// components/HapticButton.tsx
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';

interface HapticButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'destructive';
  style?: ViewStyle;
}

export function HapticButton({ label, onPress, variant = 'primary', style }: HapticButtonProps) {
  const handlePress = async () => {
    if (Platform.OS !== 'web') {
      await Haptics.impactAsync(
        variant === 'destructive'
          ? Haptics.ImpactFeedbackStyle.Heavy
          : Haptics.ImpactFeedbackStyle.Light,
      );
    }
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        styles.button,
        variant === 'destructive' && styles.destructive,
        pressed && styles.pressed,
        style,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: 'center',
    minHeight: 44,
  },
  destructive: { backgroundColor: '#FF3B30' },
  pressed: { opacity: 0.75 },
  label: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
```

**Native module bridge (Camera with custom processing)**

```typescript
// modules/CameraModule.ts — TypeScript interface over native module
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { NativeCameraModule } = NativeModules;

export interface ScanResult {
  barcode: string;
  format: 'QR_CODE' | 'EAN_13' | 'CODE_128';
  confidence: number;
}

export const CameraModule = {
  startScanning: (): Promise<void> => NativeCameraModule.startScanning(),
  stopScanning: (): Promise<void> => NativeCameraModule.stopScanning(),
  setTorchEnabled: (enabled: boolean): Promise<void> =>
    NativeCameraModule.setTorchEnabled(enabled),
};

// Event emitter for scan results
const emitter = new NativeEventEmitter(NativeCameraModule);

export function onScanResult(callback: (result: ScanResult) => void) {
  const subscription = emitter.addListener('onBarcodeScan', callback);
  return () => subscription.remove();
}
```

```swift
// iOS native module (NativeCameraModule.swift)
import AVFoundation
import React

@objc(NativeCameraModule)
class NativeCameraModule: RCTEventEmitter, AVCaptureMetadataOutputObjectsDelegate {
    private var session: AVCaptureSession?

    override func supportedEvents() -> [String]! {
        return ["onBarcodeScan"]
    }

    @objc func startScanning(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.setupAndStartSession()
            resolve(nil)
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let barcode = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = barcode.stringValue
        else { return }

        sendEvent(withName: "onBarcodeScan", body: [
            "barcode": value,
            "format": barcode.type.rawValue,
            "confidence": 0.95,
        ])
    }

    private func setupAndStartSession() { /* ... */ }
}
```

### 3. Flutter Widgets and State Management

```dart
// Flutter: BLoC pattern with Freezed data classes
// lib/features/cart/bloc/cart_bloc.dart

import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

part 'cart_bloc.freezed.dart';

@freezed
class CartEvent with _$CartEvent {
  const factory CartEvent.addItem(CartItem item) = _AddItem;
  const factory CartEvent.removeItem(String itemId) = _RemoveItem;
  const factory CartEvent.checkout() = _Checkout;
}

@freezed
class CartState with _$CartState {
  const factory CartState.idle(List<CartItem> items) = _Idle;
  const factory CartState.processing(List<CartItem> items) = _Processing;
  const factory CartState.checkoutSuccess(String orderId) = _CheckoutSuccess;
  const factory CartState.error(String message, List<CartItem> items) = _Error;
}

class CartBloc extends Bloc<CartEvent, CartState> {
  final CartRepository _repository;

  CartBloc(this._repository) : super(const CartState.idle([])) {
    on<CartEvent>((event, emit) async {
      await event.when(
        addItem: (item) => _onAddItem(item, emit),
        removeItem: (id) => _onRemoveItem(id, emit),
        checkout: () => _onCheckout(emit),
      );
    });
  }

  Future<void> _onAddItem(_AddItem event, Emitter<CartState> emit) async {
    final current = state.mapOrNull(idle: (s) => s.items) ?? [];
    emit(CartState.idle([...current, event.item]));
  }

  Future<void> _onCheckout(Emitter<CartState> emit) async {
    final items = state.mapOrNull(idle: (s) => s.items) ?? [];
    emit(CartState.processing(items));
    try {
      final orderId = await _repository.checkout(items);
      emit(CartState.checkoutSuccess(orderId));
    } catch (e) {
      emit(CartState.error(e.toString(), items));
    }
  }

  Future<void> _onRemoveItem(_RemoveItem event, Emitter<CartState> emit) async {
    final current = state.mapOrNull(idle: (s) => s.items) ?? [];
    emit(CartState.idle(current.where((i) => i.id != event.itemId).toList()));
  }
}
```

```dart
// Flutter widget consuming the BLoC
class CartScreen extends StatelessWidget {
  const CartScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CartBloc, CartState>(
      builder: (context, state) => state.when(
        idle: (items) => CartItemList(
          items: items,
          onRemove: (id) => context.read<CartBloc>().add(CartEvent.removeItem(id)),
          onCheckout: () => context.read<CartBloc>().add(const CartEvent.checkout()),
        ),
        processing: (items) => const Center(child: CircularProgressIndicator()),
        checkoutSuccess: (orderId) => OrderConfirmation(orderId: orderId),
        error: (msg, items) => ErrorBanner(message: msg),
      ),
    );
  }
}
```

### 4. Offline-First Data Sync

```swift
// iOS: Core Data + CloudKit sync
import CoreData
import CloudKit

class SyncManager {
    private let container: NSPersistentCloudKitContainer

    init() {
        container = NSPersistentCloudKitContainer(name: "AppModel")
        container.viewContext.automaticallyMergesChangesFromParent = true
        container.viewContext.mergePolicy = NSMergeByPropertyObjectTrumpMergePolicy

        let description = container.persistentStoreDescriptions.first!
        description.setOption(true as NSNumber,
                              forKey: NSPersistentHistoryTrackingKey)
        description.setOption(true as NSNumber,
                              forKey: NSPersistentStoreRemoteChangeNotificationPostOptionKey)

        container.loadPersistentStores { _, error in
            if let error { fatalError("Store failed: \(error)") }
        }
    }

    func saveContext() {
        let context = container.viewContext
        guard context.hasChanges else { return }
        do { try context.save() } catch {
            print("Save failed: \(error)")
        }
    }
}
```

```kotlin
// Android: Room + WorkManager background sync
@Entity(tableName = "tasks")
data class TaskEntity(
    @PrimaryKey val id: String,
    val title: String,
    val completed: Boolean,
    val syncStatus: SyncStatus = SyncStatus.PENDING,
    val updatedAt: Long = System.currentTimeMillis(),
)

enum class SyncStatus { SYNCED, PENDING, CONFLICT }

class SyncWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val repository: TaskRepository,
    private val apiService: ApiService,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            val pending = repository.getPendingTasks()
            pending.forEach { task ->
                apiService.upsertTask(task.toDto())
                repository.markSynced(task.id)
            }
            val remote = apiService.fetchTasks()
            repository.mergeRemote(remote)
            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }

    companion object {
        fun schedule(workManager: WorkManager) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints(NetworkType.CONNECTED))
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            workManager.enqueueUniquePeriodicWork(
                "task_sync", ExistingPeriodicWorkPolicy.KEEP, request
            )
        }
    }
}
```

### 5. Device Farm and E2E Testing

```typescript
// React Native: Detox E2E tests
// e2e/checkout.test.ts
import { device, element, by, expect as detoxExpect } from 'detox';

describe('Checkout Flow', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it('completes purchase from product detail', async () => {
    await element(by.id('product-list-item-0')).tap();
    await detoxExpect(element(by.id('product-detail-screen'))).toBeVisible();

    await element(by.id('add-to-cart-button')).tap();
    await element(by.id('cart-tab')).tap();

    await detoxExpect(element(by.id('cart-item-0'))).toBeVisible();
    await element(by.id('checkout-button')).tap();

    // Fill shipping form
    await element(by.id('address-input')).typeText('123 Main St');
    await element(by.id('city-input')).typeText('Springfield');
    await element(by.id('continue-button')).tap();

    // Confirm order
    await detoxExpect(element(by.id('order-confirmation-screen'))).toBeVisible();
    await detoxExpect(element(by.id('order-id-label'))).toBeVisible();
  });

  it('handles network failure gracefully', async () => {
    await device.setStatusBar({ networkActivity: false });
    // Simulate offline state
    await device.setURLBlacklist(['.*api.myapp.com.*']);

    await element(by.id('checkout-button')).tap();
    await detoxExpect(element(by.id('offline-banner'))).toBeVisible();

    await device.setURLBlacklist([]);
  });
});
```

```yaml
# Firebase Test Lab via GitHub Actions
# .github/workflows/device-farm.yml
name: Device Farm Tests

on:
  pull_request:
    branches: [main]

jobs:
  android-device-farm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build debug APK
        run: ./gradlew assembleDebug assembleAndroidTest

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - name: Run on Firebase Test Lab
        run: |
          gcloud firebase test android run \
            --type instrumentation \
            --app app/build/outputs/apk/debug/app-debug.apk \
            --test app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
            --device model=Pixel7,version=33,locale=en,orientation=portrait \
            --device model=SamsungS21,version=31,locale=en,orientation=portrait \
            --device model=redfin,version=30,locale=en,orientation=portrait \
            --timeout 10m \
            --results-bucket gs://my-test-results \
            --results-dir "${{ github.run_id }}"

  ios-device-farm:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - name: Build for testing
        run: |
          xcodebuild build-for-testing \
            -scheme MyApp \
            -destination 'generic/platform=iOS Simulator' \
            -derivedDataPath DerivedData

      - name: Run on BrowserStack
        env:
          BROWSERSTACK_USERNAME: ${{ secrets.BROWSERSTACK_USERNAME }}
          BROWSERSTACK_ACCESS_KEY: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
        run: |
          zip -r TestApp.zip DerivedData/Build/Products/Debug-iphonesimulator/MyApp.app
          curl -u "$BROWSERSTACK_USERNAME:$BROWSERSTACK_ACCESS_KEY" \
            -X POST "https://api-cloud.browserstack.com/app-automate/xcuitest/v2/build" \
            -F "app=@TestApp.zip" \
            -F 'data={"devices":["iPhone 15-17","iPhone 13-16"],"project":"MyApp","networkProfile":"4g-lte-good"}'
```

### 6. CI/CD with Fastlane and EAS Build

**Fastlane for native apps**

```ruby
# fastlane/Fastfile

default_platform(:ios)

platform :ios do
  desc "Run tests"
  lane :test do
    run_tests(
      scheme: "MyApp",
      devices: ["iPhone 15 Pro", "iPhone SE (3rd generation)"],
      code_coverage: true,
      output_directory: "fastlane/test_output",
    )
  end

  desc "Build and submit to TestFlight"
  lane :beta do
    ensure_git_status_clean
    increment_build_number(
      build_number: latest_testflight_build_number + 1,
    )
    build_app(
      scheme: "MyApp",
      export_method: "app-store",
      include_bitcode: false,
    )
    upload_to_testflight(
      skip_waiting_for_build_processing: true,
      changelog: changelog_from_git_commits(
        commits_count: 10,
        pretty: "- %s",
      ),
    )
    slack(
      message: "iOS beta #{lane_context[SharedValues::VERSION_NUMBER]} submitted to TestFlight",
      channel: "#mobile-releases",
    )
  end

  desc "Release to App Store"
  lane :release do
    deliver(
      submit_for_review: true,
      automatic_release: false,
      force: true,
      skip_screenshots: true,
      submission_information: {
        add_id_info_uses_idfa: false,
        export_compliance_uses_encryption: false,
      },
    )
  end
end

platform :android do
  desc "Build and upload to Play Store internal track"
  lane :beta do
    gradle(
      task: "bundle",
      build_type: "Release",
      properties: {
        "android.injected.signing.store.file" => ENV["KEYSTORE_PATH"],
        "android.injected.signing.store.password" => ENV["KEYSTORE_PASSWORD"],
        "android.injected.signing.key.alias" => ENV["KEY_ALIAS"],
        "android.injected.signing.key.password" => ENV["KEY_PASSWORD"],
      },
    )
    upload_to_play_store(
      track: "internal",
      aab: "app/build/outputs/bundle/release/app-release.aab",
    )
  end
end
```

**EAS Build for React Native**

```json
// eas.json
{
  "cli": { "version": ">= 10.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": { "simulator": true },
      "android": { "buildType": "apk" }
    },
    "preview": {
      "distribution": "internal",
      "channel": "preview",
      "ios": {
        "enterpriseProvisioning": "adhoc"
      }
    },
    "production": {
      "autoIncrement": true,
      "channel": "production",
      "ios": { "buildConfiguration": "Release" },
      "android": {
        "buildType": "app-bundle",
        "gradleCommand": ":app:bundleRelease"
      }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "team@company.com",
        "ascAppId": "1234567890",
        "appleTeamId": "XXXXXXXXXX"
      },
      "android": {
        "serviceAccountKeyPath": "./service-account.json",
        "track": "production",
        "releaseStatus": "completed"
      }
    }
  }
}
```

```yaml
# .github/workflows/eas-build.yml — EAS Build in CI
name: EAS Build

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      - uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}

      - name: Build preview (PR)
        if: github.event_name == 'pull_request'
        run: eas build --platform all --profile preview --non-interactive

      - name: Build and submit production (main)
        if: github.ref == 'refs/heads/main'
        run: |
          eas build --platform all --profile production --non-interactive
          eas submit --platform all --profile production --non-interactive
```

**Bitrise pipeline for Flutter**

```yaml
# bitrise.yml
format_version: '11'
default_step_lib_source: https://github.com/bitrise-io/bitrise-steplib.git

workflows:
  flutter_ci:
    steps:
      - activate-ssh-key@4: {}
      - git-clone@8: {}

      - flutter-installer@0:
          inputs:
            - version: stable

      - cache-pull@2: {}

      - script@1:
          title: Flutter pub get
          inputs:
            - content: flutter pub get

      - flutter-test@1:
          inputs:
            - project_location: .
            - platform: both

      - script@1:
          title: Build Android release
          inputs:
            - content: |
                flutter build appbundle \
                  --release \
                  --build-number=$BITRISE_BUILD_NUMBER

      - script@1:
          title: Build iOS release
          inputs:
            - content: |
                flutter build ipa \
                  --release \
                  --build-number=$BITRISE_BUILD_NUMBER \
                  --export-options-plist=ios/ExportOptions.plist

      - deploy-to-itunesconnect-application-loader@1:
          inputs:
            - ipa_path: build/ios/ipa/MyApp.ipa
            - apple_id: $APPLE_ID
            - password: $APP_SPECIFIC_PASSWORD

      - google-play@1:
          inputs:
            - service_account_json_key_path: $BITRISEIO_SERVICE_ACCOUNT_JSON_KEY_URL
            - package_name: com.mycompany.myapp
            - app_path: build/app/outputs/bundle/release/app-release.aab
            - track: internal

      - cache-push@2: {}
```

## Few-Shot Examples

### Example 1: Architecture Review

**Prompt**: "Review this iOS app — it's getting slow and the code is hard to maintain."

**Response**:

After reviewing the codebase, I see three root causes for both slowness and maintainability issues.

**Problem 1 — Massive ViewControllers**: `HomeViewController` is 1,400 lines with network calls, data transformation, and UI logic interleaved. Extract a ViewModel:

```swift
@MainActor
final class HomeViewModel: ObservableObject {
    @Published private(set) var items: [FeedItem] = []
    @Published private(set) var isLoading = false

    private let fetchFeed: FetchFeedUseCase

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        items = (try? await fetchFeed.execute()) ?? items
    }
}
```

**Problem 2 — URLSession on main thread**: `URLSession.shared.dataTask` completions update UI without dispatching to main. Use `async/await` which handles threading correctly.

**Problem 3 — No image caching**: `UIImage(contentsOfFile:)` is called in `cellForRowAt`, decoding images on the main thread per scroll. Use `SDWebImage` or an `NSCache`-backed async loader.

---

### Example 2: CI/CD Setup

**Prompt**: "How do we automate our React Native releases to both stores?"

**Response**:

Use EAS Build for building and EAS Submit for store delivery. The setup takes about a day but eliminates all manual steps:

```bash
# Install EAS CLI
npm install -g eas-cli

# Initialize
eas build:configure
eas submit:configure

# Add to CI — this handles both stores in one command
eas build --platform all --profile production --non-interactive
eas submit --platform all --profile production --non-interactive
```

Configure `eas.json` with three profiles: `development` (simulator/APK for local testing), `preview` (ad-hoc/internal for QA), and `production` (App Store/Play Store). Store credentials live in EAS secrets, not in your repo.

For Android, the service account JSON from Google Play Console gives EAS permission to upload. For iOS, Expo manages provisioning profiles automatically via App Store Connect API key — no more certificate sharing between team members.

---

### Example 3: Performance Profiling

**Prompt**: "Our Flutter list screen drops frames on older Android devices."

**Response**:

Frame drops in Flutter lists almost always come from expensive `build()` methods, synchronous image decoding, or rebuilding too much of the widget tree per scroll.

**Step 1 — Enable performance overlay**:
```dart
MaterialApp(
  showPerformanceOverlay: true, // Red bars = jank
  ...
)
```

**Step 2 — Profile with DevTools**: Run `flutter run --profile` and open Dart DevTools. Sort the flame chart by self time to find the expensive widget.

**Most common fix — const constructors and ListView.builder**:
```dart
// BEFORE: Rebuilds all items on any state change
ListView(children: items.map((i) => ItemWidget(item: i)).toList())

// AFTER: Only builds visible items
ListView.builder(
  itemCount: items.length,
  itemBuilder: (context, index) => ItemWidget(item: items[index]),
)

// ALSO: Mark stateless widgets const
const ItemWidget({super.key, required this.item});
```

**If images are the issue**: Use `cached_network_image` with `memCacheWidth` to resize on decode rather than storing full-resolution images in memory.
