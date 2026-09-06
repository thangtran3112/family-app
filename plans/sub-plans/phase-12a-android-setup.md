# Phase 12A — Mobile App Architecture & Setup (Flutter Candidate for Android)

> **Milestone**: 5 (Mobile App — Deferred post-PWA)
> **Dependencies**: Milestone 0 (Web MVP with PWA), Milestone 3 (Ingestion API)
> **Estimated Effort**: 3-5 days

---

## Objective

Evaluate and bootstrap the dedicated mobile application.
- **Immediate mobile scanning**: Fulfilled by the Next.js 16 client-side PWA (Phase 0F).
- **Future mobile app**: Planned primarily for Android (with cross-platform iOS compatibility). We **may use Flutter** for the Android app; we are **undecided yet and it may not be Expo React Native**.

---

## Architectural Context: Why Flutter is the Prime Candidate

| Consideration | Flutter (Prime Candidate) | Expo / React Native |
|---------------|---------------------------|---------------------|
| **Backend Alignment** | Backend is Python (FastAPI). React Native offers no monorepo code-sharing advantage for backend logic or ORMs. | Monorepo TypeScript sharing is only with Next.js client UI components. |
| **Camera & Document Scanning** | Direct access to high-performance camera plugins (`camera`, `google_mlkit_document_scanner`) with zero bridge jank. | Camera modules often require native TurboModules or bridge serialization. |
| **UI Performance** | Direct Skia/Impeller GPU canvas rendering; rock-solid 60/120fps animations on Android devices. | Fabric renderer has improved, but still relies on platform view bridges. |
| **Offline Data** | Excellent embedded SQLite libraries (`sqflite`, `isar`, `drift`) for robust offline receipt queuing. | WatermelonDB / SQLite expo plugins. |
| **Language** | Dart — statically typed, sound null safety, compiles to ARM native code. | TypeScript / JavaScript. |

> [!NOTE]
> The final framework decision will be confirmed at the kickoff of Milestone 12. However, the plan is pre-architected around Flutter as the leading candidate for the Android app.

---

## Tasks

### 1. Framework Evaluation Benchmark (Kickoff Milestone 12)
- [ ] Benchmark Flutter camera document scanner vs. PWA camera on target Android hardware
- [ ] Confirm decision: Proceed with Flutter in `apps/mobile/` (or alternative if requirements shift)

### 2. Flutter Project Setup (`apps/mobile/`)
- [ ] Initialize Flutter 3.27+ project targeting Android (minSdk 24, targetSdk 35) and iOS
- [ ] Configure Material 3 theme matching Next.js dark mode design tokens
- [ ] Set up state management (Riverpod or Bloc)
- [ ] Setup API client with `dio`:
  - Base URL pointing to Traefik gateway (`/api/v1`)
  - Auto-attach JWT auth header
  - Auto-refresh expired access tokens
- [ ] Configure `flutter_secure_storage` for encrypted storage of JWT and tenant credentials

### 3. Core Shell Navigation
- [ ] Bottom navigation bar:
  - **Dashboard**: Quick expense summary & recent scans
  - **Scan (Center action)**: Camera scanner view
  - **Expenses**: Filterable expense list
  - **Settings**: Account & tenant configuration

---

## Definition of Done

- [ ] Flutter app builds and runs on Android emulator and physical Android phone
- [ ] User can authenticate against FastAPI backend (`/api/v1/auth/login`)
- [ ] Tokens are securely stored in Android Keystore via `flutter_secure_storage`
- [ ] Navigation shell renders cleanly in dark mode
