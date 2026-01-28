plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.androidremote.screenserver"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.androidremote.screenserver"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // No signing config needed - this APK is only used via app_process
    // and never installed normally
}

dependencies {
    // No external dependencies - this module runs via app_process
    // and must be self-contained
}
