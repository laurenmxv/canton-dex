package com.openzeppelin.dex;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

import com.tngtech.archunit.core.importer.ClassFileImporter;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class ArchitectureTest {
  @Test
  void modulesStayIndependentAndLedgerTypesStayInsideCanton() throws Exception {
    var classes =
        new ClassFileImporter()
            .importPath(
                Path.of(
                    DexApplication.class
                        .getProtectionDomain()
                        .getCodeSource()
                        .getLocation()
                        .toURI()));
    slices().matching("com.openzeppelin.dex.(*)..").should().beFreeOfCycles().check(classes);
    noClasses()
        .that()
        .resideOutsideOfPackages("..iam..", "..onboarding..", "..pools..", "..bootstrap..")
        .should()
        .dependOnClassesThat()
        .resideInAnyPackage("org.springframework.jdbc..")
        .check(classes);
    noClasses()
        .that()
        .resideOutsideOfPackage("..canton..")
        .should()
        .dependOnClassesThat()
        .resideInAnyPackage("com.daml..", "io.grpc..", "com.openzeppelin.dex.canton.generated..")
        .check(classes);
    noClasses()
        .that()
        .resideOutsideOfPackage("..onboarding..")
        .should()
        .dependOnClassesThat()
        .haveSimpleName("OnboardingStore")
        .allowEmptyShould(true)
        .check(classes);
  }
}
