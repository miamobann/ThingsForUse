pluginManagement {
    repositories {
        if (!providers.gradleProperty("coreOnly").isPresent) google()
        mavenCentral()
        gradlePluginPortal()
    }
    // 버전은 여기서만 정하고, 실제로 쓰는 모듈에서만 불러온다.
    plugins {
        id("com.android.application") version "8.7.3"
        id("org.jetbrains.kotlin.android") version "2.0.21"
        id("org.jetbrains.kotlin.plugin.compose") version "2.0.21"
        id("org.jetbrains.kotlin.jvm") version "2.0.21"
    }
}
dependencyResolutionManagement {
    repositories {
        if (!providers.gradleProperty("coreOnly").isPresent) google()
        mavenCentral()
    }
}

rootProject.name = "budget-app"

// 핵심 로직(core)은 안드로이드 없이도 빌드·테스트할 수 있다.
// 안드로이드 SDK가 없는 곳에서는 `-PcoreOnly`로 core만 돌린다.
include(":core")
if (!providers.gradleProperty("coreOnly").isPresent) {
    include(":app")
}
