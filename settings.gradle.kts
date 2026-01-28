pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "AndroidRemote"

// Core modules (pure Kotlin, no Android dependencies)
include(":core-crypto")
include(":core-protocol")
include(":core-transport")

// Feature modules (Android-specific)
include(":feature-screen")
include(":feature-input")
include(":feature-files")
include(":feature-camera")

// Screen capture server (runs via app_process, scrcpy-style)
include(":screen-server")

// Main application
include(":app")
