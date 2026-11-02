plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "budget.app"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "0.1.${System.getenv("GITHUB_RUN_NUMBER") ?: "0"}"
    }

    // 업데이트 설치가 되려면 매번 같은 키로 서명해야 한다. 비공개 저장소라 키를 같이 둔다.
    // personal = Min이 쓰는 앱, share = 다른 사람에게 주는 범용판 (앱 id와 키가 달라 따로 설치된다)
    signingConfigs {
        create("shared") {
            storeFile = file("signing.jks")
            storePassword = "budgetapp"
            keyAlias = "budget"
            keyPassword = "budgetapp"
        }
        create("share") {
            storeFile = file("signing-share.jks")
            storePassword = "gagyebu-share"
            keyAlias = "share"
            keyPassword = "gagyebu-share"
        }
    }

    flavorDimensions += "edition"
    productFlavors {
        create("personal") {
            dimension = "edition"
            applicationId = "com.thingsforuse.budget"
            signingConfig = signingConfigs.getByName("shared")
        }
        create("share") {
            dimension = "edition"
            applicationId = "com.thingsforuse.gagyebu"
            signingConfig = signingConfigs.getByName("share")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(project(":core"))

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.core:core-ktx:1.15.0")
}
