import org.gradle.kotlin.dsl.KotlinClosure2

plugins {
    java
    id("org.springframework.boot") version "4.1.1"
    id("io.spring.dependency-management") version "1.1.7"
    id("com.diffplug.spotless") version "7.2.1"
}

layout.buildDirectory = file(providers.environmentVariable("DEX_BUILD_DIR").getOrElse("build"))

group = "com.openzeppelin.dex"
version = "0.1.0"
java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
repositories { mavenCentral() }

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-oauth2-resource-server")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.postgresql:postgresql")
    implementation("com.daml:bindings-java:3.5.7")
    implementation("com.daml:ledger-api-proto:3.5.7")
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    implementation("io.grpc:grpc-netty-shaded")
    implementation("io.grpc:grpc-stub")
    implementation("io.grpc:grpc-protobuf")
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.assertj:assertj-core")
    testImplementation("org.awaitility:awaitility")
    testImplementation("com.tngtech.archunit:archunit-junit5:1.4.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

val contractsDirectory = layout.projectDirectory.dir("../contracts")
val contractDar = contractsDirectory.file(".daml/dist/canton-dex-ri-0.1.0.dar")
val faucetDar = contractsDirectory.file("test-faucet/.daml/dist/canton-dex-test-faucet-0.1.0.dar")
val damlBindingsDirectory = layout.buildDirectory.dir("generated/sources/daml")
val dpmExecutable = providers.environmentVariable("DPM_BIN").getOrElse("dpm")

val buildContracts by tasks.registering(Exec::class) {
    workingDir(contractsDirectory.asFile)
    environment("DAML_PACKAGE", contractsDirectory.asFile.absolutePath)
    commandLine(dpmExecutable, "build", "--all")
    inputs.dir(contractsDirectory.dir("daml"))
    inputs.dir(contractsDirectory.dir("dars"))
    inputs.dir(contractsDirectory.dir("test-faucet/daml"))
    inputs.dir(contractsDirectory.dir("tests/daml"))
    inputs.files(contractsDirectory.file("daml.yaml"), contractsDirectory.file("multi-package.yaml"), contractsDirectory.file("test-faucet/daml.yaml"), contractsDirectory.file("tests/daml.yaml"))
    outputs.files(contractDar, faucetDar)
}
val generateDamlBindings by tasks.registering(Exec::class) {
    dependsOn(buildContracts)
    workingDir(contractsDirectory.asFile)
    environment("DAML_PACKAGE", contractsDirectory.asFile.absolutePath)
    commandLine(
        dpmExecutable, "codegen-java",
        "${contractDar.asFile.absolutePath}=com.openzeppelin.dex.canton.generated",
        "${faucetDar.asFile.absolutePath}=com.openzeppelin.dex.canton.generated",
        "-o", damlBindingsDirectory.get().asFile.absolutePath
    )
    inputs.files(contractDar, faucetDar)
    inputs.files(contractsDirectory.file("daml.yaml"), contractsDirectory.file("multi-package.yaml"), contractsDirectory.file("test-faucet/daml.yaml"), contractsDirectory.file("tests/daml.yaml"))
    outputs.dir(damlBindingsDirectory)
    doFirst {
        delete(damlBindingsDirectory)
        damlBindingsDirectory.get().asFile.mkdirs()
    }
}
sourceSets.main { java.srcDir(damlBindingsDirectory) }
tasks.compileJava { dependsOn(generateDamlBindings) }
springBoot { mainClass = "com.openzeppelin.dex.DexApplication" }
tasks.register<JavaExec>("bootstrap") {
    dependsOn(tasks.classes)
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass = "com.openzeppelin.dex.bootstrap.BootstrapMain"
}
tasks.test { useJUnitPlatform { excludeTags("integration") } }
tasks.register<Test>("integrationTest") {
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    useJUnitPlatform { includeTags("integration") }
    systemProperty("scenario", providers.gradleProperty("scenario").getOrElse("all"))
    outputs.upToDateWhen { false }
    afterSuite(KotlinClosure2<TestDescriptor, TestResult, Unit>({ descriptor, result ->
        if (descriptor.parent == null && result.testCount == result.skippedTestCount) {
            throw GradleException("No integration scenario executed")
        }
    }))
    testLogging { events("passed", "failed", "skipped"); showStandardStreams = true }
}
spotless {
    java { target("src/**/*.java"); googleJavaFormat("1.28.0") }
}

tasks.register<JavaExec>("poolDecision") {
    dependsOn(tasks.classes)
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass = "com.openzeppelin.dex.bootstrap.PoolDecisionMain"
    args(providers.gradleProperty("decision").getOrElse(""), providers.gradleProperty("proposal").getOrElse(""))
    providers.gradleProperty("initialRatio").orNull?.let { args(it) }
}
